import { openAsBlob } from 'node:fs';
import type { DictionaryContext } from '@app/shared';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import type { LlmJsonRequest, LlmProvider, LlmTextRequest, TranscribeOptions, TranscriptionProvider } from './types.js';

type FetchFn = typeof fetch;

/** OpenAIのHTTPエラーをアプリのエラーコードへ変換する。レスポンス本文は診断用にコードのみ使う。 */
export async function mapHttpError(res: Response): Promise<AppError> {
  let code = '';
  try {
    const body = (await res.json()) as { error?: { code?: string; type?: string } };
    code = body?.error?.code ?? body?.error?.type ?? '';
  } catch {
    /* 本文なし */
  }
  if (res.status === 401 || res.status === 403) return new AppError('provider_auth_failed');
  if (res.status === 429) {
    return code.includes('quota') || code === 'billing_hard_limit_reached'
      ? new AppError('quota_exceeded')
      : new AppError('rate_limited');
  }
  if (res.status === 413) return new AppError('file_too_large', 'AIサービスの受付上限（25MB）を超えました。');
  if (res.status >= 500) return new AppError('provider_error');
  return new AppError('provider_error', `AIサービスがリクエストを受け付けませんでした（HTTP ${res.status}${code ? ` / ${code}` : ''}）。`);
}

function wrapNetworkError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const name = (e as { name?: string })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return new AppError('timeout', undefined, { cause: e });
  return new AppError('provider_error', 'AIサービスへ接続できませんでした。', { cause: e });
}

/** 用語辞書を、プロンプト向けの短い文字列へ変換する（whisper-1 は224トークン制限のため切り詰め）。 */
export function dictionaryToPrompt(dict: DictionaryContext | undefined, maxChars: number): string {
  if (!dict || dict.terms.length === 0) return '';
  let out = '専門用語: ';
  for (const t of dict.terms) {
    const add = (out.endsWith(': ') ? '' : '、') + t.term;
    if (out.length + add.length > maxChars) break;
    out += add;
  }
  return out;
}

function requireKey(cfg: Config): void {
  if (!cfg.openaiApiKey) throw new AppError('api_key_missing');
}

export class OpenAITranscriptionProvider implements TranscriptionProvider {
  readonly name = 'openai';
  constructor(
    private readonly cfg: Config,
    private readonly fetchImpl: FetchFn = fetch,
  ) {}
  get model(): string {
    return this.cfg.transcribeModel;
  }

  async transcribe(filePath: string, opt: TranscribeOptions): Promise<{ text: string }> {
    requireKey(this.cfg);
    const family = this.model.startsWith('gpt-transcribe') ? 'new' : this.model === 'whisper-1' ? 'whisper' : 'gpt4o';
    const lang = opt.language ?? this.cfg.transcribeLanguage;
    const hasTerms = !!opt.dictionary && opt.dictionary.terms.length > 0;
    const blob = await openAsBlob(filePath, { type: 'audio/mpeg' });

    const build = (enhanced: boolean): FormData => {
      const form = new FormData();
      form.append('file', blob, 'audio.mp3');
      form.append('model', this.model);
      form.append('response_format', 'json');
      if (family === 'new') {
        // gpt-transcribe は languages[] / keywords を受け付ける（keywords の送信形式は公式リファレンスに明記が無く未検証）。
        // enhanced=false は 400 時のフォールバックで、これらを付けない。
        if (enhanced && lang) form.append('languages[]', lang);
        if (enhanced && hasTerms) for (const t of opt.dictionary!.terms) form.append('keywords[]', t.term);
      } else {
        if (lang) form.append('language', lang);
        const p = dictionaryToPrompt(opt.dictionary, family === 'whisper' ? 200 : 600);
        if (p) form.append('prompt', p);
      }
      return form;
    };

    const attempt = async (enhanced: boolean): Promise<{ text: string }> => {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.cfg.openaiBaseUrl}/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.cfg.openaiApiKey}` },
          body: build(enhanced),
          signal: opt.signal ?? AbortSignal.timeout(this.cfg.requestTimeoutMs),
        });
      } catch (e) {
        throw wrapNetworkError(e);
      }
      if (!res.ok) {
        const err = await mapHttpError(res);
        (err as AppError & { httpStatus?: number }).httpStatus = res.status;
        throw err;
      }
      const body = (await res.json()) as { text?: unknown };
      if (typeof body.text !== 'string') throw new AppError('provider_error', 'AIサービスの応答形式が想定と異なります。');
      return { text: body.text };
    };

    try {
      return await attempt(true);
    } catch (e) {
      const status = (e as { httpStatus?: number }).httpStatus;
      if (family === 'new' && status === 400 && (hasTerms || lang)) return attempt(false);
      throw e;
    }
  }
}

function extractOutputText(body: unknown): string {
  const b = body as { output_text?: unknown; output?: { type?: string; content?: { type?: string; text?: string }[] }[] };
  if (typeof b?.output_text === 'string') return b.output_text;
  const parts: string[] = [];
  for (const item of b?.output ?? []) {
    if (item.type !== 'message') continue;
    for (const c of item.content ?? []) if (c.type === 'output_text' && typeof c.text === 'string') parts.push(c.text);
  }
  if (parts.length === 0) throw new AppError('provider_error', 'AIサービスから本文が返りませんでした。');
  return parts.join('');
}

export class OpenAILlmProvider implements LlmProvider {
  readonly name = 'openai';
  constructor(
    private readonly cfg: Config,
    private readonly fetchImpl: FetchFn = fetch,
  ) {}

  private async call(payload: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    requireKey(this.cfg);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.openaiBaseUrl}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.openaiApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, store: false }),
        signal: signal ?? AbortSignal.timeout(this.cfg.requestTimeoutMs),
      });
    } catch (e) {
      throw wrapNetworkError(e);
    }
    if (!res.ok) throw await mapHttpError(res);
    return extractOutputText(await res.json());
  }

  generateText(req: LlmTextRequest): Promise<string> {
    return this.call({ model: req.model, instructions: req.instructions, input: req.input }, req.signal);
  }

  async generateJson(req: LlmJsonRequest): Promise<unknown> {
    const text = await this.call(
      {
        model: req.model,
        instructions: req.instructions,
        input: req.input,
        text: { format: { type: 'json_schema', name: req.schemaName, schema: req.schema, strict: true } },
      },
      req.signal,
    );
    try {
      return JSON.parse(text);
    } catch (cause) {
      throw new AppError('provider_error', 'AIサービスの応答がJSONとして解釈できませんでした。', { cause });
    }
  }
}

