import { createWriteStream, existsSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { stat } from 'node:fs/promises';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { OUTPUT_KINDS, type ConfigResponse, type DictionaryContext, type OutputKind } from '@app/shared';
import { validateAudioFile } from './audio/validate.js';
import type { Config } from './config.js';
import { AppError, isAppError } from './errors.js';
import { JobManager } from './jobs.js';
import { LlmService } from './llm/service.js';
import { log } from './log.js';
import type { LlmProvider, TranscriptionProvider } from './providers/types.js';

export interface AppDeps {
  cfg: Config;
  transcription: TranscriptionProvider;
  llm: LlmProvider;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

function parseDictionary(raw: unknown): DictionaryContext | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const terms = (v as DictionaryContext)?.terms;
    if (!Array.isArray(terms)) return undefined;
    return {
      terms: terms
        .filter((t) => t && typeof t.term === 'string' && t.term.trim())
        .slice(0, 500)
        .map((t) => ({
          term: String(t.term).slice(0, 100),
          misrecognitions: Array.isArray(t.misrecognitions) ? t.misrecognitions.slice(0, 20).map((m: unknown) => String(m).slice(0, 100)) : [],
        })),
    };
  } catch {
    throw new AppError('bad_request', '辞書データの形式が正しくありません。');
  }
}

export async function buildApp(deps: AppDeps): Promise<{ app: FastifyInstance; jobs: JobManager }> {
  const { cfg } = deps;
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024, trustProxy: true });
  const jobs = new JobManager(cfg, deps.transcription);
  const llm = new LlmService(deps.llm, cfg);
  await jobs.start();
  app.addHook('onClose', async () => jobs.stop());

  await app.register(multipart, { limits: { fileSize: cfg.maxUploadBytes, files: 1, fields: 10, parts: 12 } });

  // ---- 認証 + 簡易レート制限（/api/* のみ。/api/health は除く） ----
  const hits = new Map<string, { n: number; t: number }>();
  app.addHook('onRequest', async (req) => {
    const url = req.url.split('?')[0] ?? '';
    if (!url.startsWith('/api/') || url === '/api/health') return;
    const now = Date.now();
    const h = hits.get(req.ip);
    if (!h || now - h.t > 60_000) hits.set(req.ip, { n: 1, t: now });
    else if (++h.n > cfg.rateLimitPerMin) throw new AppError('rate_limited', 'リクエストが多すぎます。少し待ってください。');
    if (cfg.accessToken) {
      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!safeEqual(token, cfg.accessToken)) throw new AppError('unauthorized');
    }
  });

  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    let e: AppError;
    const code = (err as { code?: string })?.code;
    if (isAppError(err)) e = err;
    else if (code === 'FST_REQ_FILE_TOO_LARGE') e = new AppError('file_too_large', `ファイルが大きすぎます（上限 ${Math.floor(cfg.maxUploadBytes / 1024 / 1024)}MB）。`);
    else if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') e = new AppError('bad_request', '送信データが大きすぎます。');
    else if (code?.startsWith('FST_')) e = new AppError('bad_request');
    else e = new AppError('internal');
    if (e.code === 'internal') log('request.error', { path: req.url.split('?')[0], name: (err as Error)?.name });
    void reply.status(e.status).send(e.toBody());
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/config', async (): Promise<ConfigResponse> => ({
    provider: cfg.provider,
    transcribeModel: deps.transcription.model,
    llmModel: cfg.llmModel,
    llmModelLight: cfg.llmModelLight,
    maxUploadMb: Math.floor(cfg.maxUploadBytes / 1024 / 1024),
    maxDurationMin: Math.floor(cfg.maxDurationSec / 60),
    hasApiKey: cfg.provider === 'mock' || !!cfg.openaiApiKey,
  }));

  function requireKey() {
    if (cfg.provider === 'openai' && !cfg.openaiApiKey) throw new AppError('api_key_missing');
  }

  // ---- 文字起こしジョブ ----
  app.post('/api/transcribe-jobs', async (req, reply) => {
    requireKey();
    const idem = typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'].slice(0, 100) : undefined;
    if (idem) {
      const existing = jobs.findByIdempotencyKey(idem);
      if (existing) return reply.status(200).send(existing);
    }
    const { dir, sourcePath } = await jobs.createUploadDir();
    let handedOff = false;
    try {
      let dictionary: DictionaryContext | undefined;
      let size = 0;
      let gotFile = false;
      for await (const part of req.parts()) {
        if (part.type === 'field') {
          if (part.fieldname === 'dictionary') dictionary = parseDictionary(part.value);
          continue;
        }
        if (gotFile) {
          part.file.resume();
          continue;
        }
        gotFile = true;
        // ファイル名はサーバー上のパスに一切使わない（保存先は固定名）
        await pipeline(part.file, createWriteStream(sourcePath, { mode: 0o600 }));
        if (part.file.truncated) throw new AppError('file_too_large', `ファイルが大きすぎます（上限 ${Math.floor(cfg.maxUploadBytes / 1024 / 1024)}MB）。`);
        size = (await stat(sourcePath)).size;
      }
      if (!gotFile) throw new AppError('bad_request', '音声ファイルが添付されていません。');
      const { durationSec } = await validateAudioFile(sourcePath, {
        size,
        maxBytes: cfg.maxUploadBytes,
        maxDurationSec: cfg.maxDurationSec,
      });
      const view = jobs.create({ dir, sourcePath, durationSec, dictionary, idempotencyKey: idem });
      handedOff = true;
      return reply.status(202).send(view);
    } finally {
      if (!handedOff) await jobs.discardUploadDir(dir);
    }
  });

  app.get<{ Params: { id: string } }>('/api/transcribe-jobs/:id', async (req) => jobs.get(req.params.id));
  app.post<{ Params: { id: string } }>('/api/transcribe-jobs/:id/retry', async (req, reply) => reply.status(202).send(jobs.retry(req.params.id)));
  app.delete<{ Params: { id: string } }>('/api/transcribe-jobs/:id', async (req, reply) => {
    await jobs.delete(req.params.id);
    return reply.status(204).send();
  });

  // ---- LLM ----
  const textOf = (body: unknown): string => {
    const t = (body as { text?: unknown })?.text;
    if (typeof t !== 'string' || !t.trim()) throw new AppError('bad_request', 'テキストが空です。');
    if (t.length > 400_000) throw new AppError('bad_request', 'テキストが長すぎます。');
    return t;
  };

  app.post('/api/llm/proofread', async (req) => {
    requireKey();
    const b = req.body as { dictionary?: unknown };
    return { candidates: await llm.proofread(textOf(req.body), parseDictionary(b?.dictionary)) };
  });
  app.post('/api/llm/polish', async (req) => {
    requireKey();
    const b = req.body as { dictionary?: unknown };
    return llm.polish(textOf(req.body), parseDictionary(b?.dictionary));
  });
  app.post('/api/llm/generate', async (req) => {
    requireKey();
    const b = req.body as { kind?: string; title?: unknown; dictionary?: unknown };
    if (!b?.kind || !(OUTPUT_KINDS as readonly string[]).includes(b.kind)) throw new AppError('bad_request', '生成の種類が不正です。');
    const title = typeof b.title === 'string' ? b.title.slice(0, 200) : undefined;
    return llm.generate(b.kind as OutputKind, textOf(req.body), title, parseDictionary(b.dictionary));
  });

  // ---- Share Target フォールバック ----
  // Service Worker が共有POSTを横取りするのが正規経路。SW未制御でここに届いた場合は音声を保存せず破棄し、案内画面へ戻す。
  app.post('/share-target', async (req, reply) => {
    req.raw.resume();
    return reply.redirect('/?share_error=nosw', 303);
  });

  // ---- 静的配信 (PWA) ----
  if (existsSync(cfg.webDist)) {
    await app.register(fastifyStatic, {
      root: cfg.webDist,
      wildcard: false,
      setHeaders(res, filePath) {
        if (/[\\/]assets[\\/]/.test(filePath)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
        else res.header('Cache-Control', 'no-cache'); // index.html / sw.js / manifest は常に再検証
        if (filePath.endsWith('sw.js')) res.header('Service-Worker-Allowed', '/');
      },
    });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: { code: 'bad_request', message: '見つかりません。', retryable: false } });
    });
  }

  return { app, jobs };
}
