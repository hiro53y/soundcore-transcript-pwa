import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { JobManager } from '../src/jobs.js';
import { AppError } from '../src/errors.js';
import { MockLlmProvider, MockTranscriptionProvider } from '../src/providers/mock.js';
import type { TranscribeOptions, TranscriptionProvider } from '../src/providers/types.js';
import { makeMp3, multipartBody, testConfig } from './helpers.js';

const AUTH = { authorization: 'Bearer test-token-123456' };
let app: FastifyInstance | undefined;
let jobs: JobManager | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function setup(transcription: TranscriptionProvider = new MockTranscriptionProvider(), over = {}) {
  const cfg = testConfig(over);
  ({ app, jobs } = await buildApp({ cfg, transcription, llm: new MockLlmProvider() }));
  return { app, jobs: jobs!, cfg };
}

async function upload(a: FastifyInstance, file: Buffer, headers: Record<string, string> = {}, name = 'x.mp3', fields = {}) {
  const m = multipartBody(file, name, fields);
  return a.inject({ method: 'POST', url: '/api/transcribe-jobs', payload: m.body, headers: { ...AUTH, ...m.headers, ...headers } });
}

async function waitDone(a: FastifyInstance, id: string) {
  for (let i = 0; i < 800; i++) {
    const r = await a.inject({ method: 'GET', url: `/api/transcribe-jobs/${id}`, headers: AUTH });
    const v = r.json();
    if (['done', 'partial', 'failed'].includes(v.status)) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timeout');
}

describe('認証・設定', () => {
  it('トークン無しは401、healthは通る、configにAPIキーは含まれない', async () => {
    const { app: a } = await setup();
    expect((await a.inject({ method: 'GET', url: '/api/config' })).statusCode).toBe(401);
    expect((await a.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    const c = await a.inject({ method: 'GET', url: '/api/config', headers: AUTH });
    expect(c.statusCode).toBe(200);
    expect(c.body).not.toContain('sk-test');
    expect(c.json().hasApiKey).toBe(true);
  });
  it('OpenAI APIキー未設定は503 api_key_missing', async () => {
    const { app: a } = await setup(new MockTranscriptionProvider(), { provider: 'openai', openaiApiKey: '' });
    const r = await upload(a, readFileSync(makeMp3({ seconds: 2 })));
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('api_key_missing');
  });
});

describe('文字起こしジョブ', () => {
  it('MP3を受け付け、完了後に一時ファイルが消える', async () => {
    const { app: a, jobs: j } = await setup();
    const r = await upload(a, readFileSync(makeMp3({ seconds: 4 })), {}, 'x.mp3', { dictionary: JSON.stringify({ terms: [{ term: 'CGL', misrecognitions: ['シージーエル'] }] }) });
    expect(r.statusCode).toBe(202);
    const v = await waitDone(a, r.json().id);
    expect(v.status).toBe('done');
    expect(v.text).toContain('モックの文字起こし');
    expect(await j.tmpDirCount()).toBe(0);
    expect((await a.inject({ method: 'DELETE', url: `/api/transcribe-jobs/${v.id}`, headers: AUTH })).statusCode).toBe(204);
    expect((await a.inject({ method: 'GET', url: `/api/transcribe-jobs/${v.id}`, headers: AUTH })).statusCode).toBe(404);
  });

  it('長い音声は無音点で分割され、順番に結合される', async () => {
    const { app: a, jobs: j } = await setup();
    const r = await upload(a, readFileSync(makeMp3({ seconds: 40, silenceAtSec: [9, 19, 29] })));
    const v = await waitDone(a, r.json().id);
    expect(v.status).toBe('done');
    expect(v.chunks.length).toBeGreaterThanOrEqual(3);
    const idx = [...v.text.matchAll(/区間(\d+)/g)].map((m) => Number(m[1]));
    expect(idx).toEqual([...idx].sort((x, y) => x - y));
    expect(v.text).toMatch(/\[00:00:00\]/);
    expect(await j.tmpDirCount()).toBe(0);
  });

  it('不正ファイルは4xxで即エラー、一時ファイルを残さない', async () => {
    const { app: a, jobs: j } = await setup();
    const txt = await upload(a, Buffer.from('これはMP3ではありません'));
    expect(txt.statusCode).toBe(415);
    expect(txt.json().error.code).toBe('file_not_audio');
    const empty = await upload(a, Buffer.alloc(0));
    expect(empty.json().error.code).toBe('file_empty');
    expect(await j.tmpDirCount()).toBe(0);
  });

  it('大容量ファイルはfile_too_large', async () => {
    const { app: a, jobs: j } = await setup(new MockTranscriptionProvider(), { maxUploadBytes: 1024 });
    const r = await upload(a, Buffer.alloc(5000, 1));
    expect(r.statusCode).toBe(413);
    expect(r.json().error.code).toBe('file_too_large');
    expect(await j.tmpDirCount()).toBe(0);
  });

  it('同じIdempotency-Keyの再送は同一ジョブを返し二重実行しない', async () => {
    let calls = 0;
    const slow: TranscriptionProvider = {
      name: 'slow',
      model: 'm',
      async transcribe() {
        calls++;
        await new Promise((r) => setTimeout(r, 150));
        return { text: 'ok' };
      },
    };
    const { app: a } = await setup(slow);
    const file = readFileSync(makeMp3({ seconds: 3 }));
    const r1 = await upload(a, file, { 'idempotency-key': 'k1' });
    const r2 = await upload(a, file, { 'idempotency-key': 'k1' });
    expect(r2.json().id).toBe(r1.json().id);
    await waitDone(a, r1.json().id);
    expect(calls).toBe(1);
  });

  it('一部チャンク失敗→partial、失敗分のみ再試行で完了', async () => {
    let failIndex1 = true;
    const calls: number[] = [];
    const flaky: TranscriptionProvider = {
      name: 'flaky',
      model: 'm',
      async transcribe(_f: string, o: TranscribeOptions) {
        calls.push(o.chunkIndex);
        if (o.chunkIndex === 1 && failIndex1) throw new AppError('provider_error');
        return { text: `text${o.chunkIndex}` };
      },
    };
    const { app: a } = await setup(flaky);
    const r = await upload(a, readFileSync(makeMp3({ seconds: 40, silenceAtSec: [9, 19, 29] })));
    const v = await waitDone(a, r.json().id);
    expect(v.status).toBe('partial');
    expect(v.retryable).toBe(true);
    expect(v.chunks.filter((c: { status: string }) => c.status === 'failed')).toHaveLength(1);
    expect(v.text).toContain('text0');
    const before = calls.length;
    failIndex1 = false;
    const rr = await a.inject({ method: 'POST', url: `/api/transcribe-jobs/${v.id}/retry`, headers: AUTH });
    expect(rr.statusCode).toBe(202);
    const v2 = await waitDone(a, v.id);
    expect(v2.status).toBe('done');
    expect(calls.slice(before)).toEqual([1]); // 失敗チャンクのみ再実行
  });

  it('認証エラーは再試行せず failed、一時ファイルは即削除', async () => {
    const bad: TranscriptionProvider = {
      name: 'bad',
      model: 'm',
      async transcribe() {
        throw new AppError('provider_auth_failed');
      },
    };
    const { app: a, jobs: j } = await setup(bad);
    const r = await upload(a, readFileSync(makeMp3({ seconds: 3 })));
    const v = await waitDone(a, r.json().id);
    expect(v.status).toBe('failed');
    expect(v.errorCode).toBe('provider_auth_failed');
    expect(await j.tmpDirCount()).toBe(0);
  });

  it('partialの一時ファイルはTTL経過で掃除される', async () => {
    const bad: TranscriptionProvider = {
      name: 'bad',
      model: 'm',
      async transcribe() {
        throw new AppError('provider_error');
      },
    };
    const { app: a, jobs: j } = await setup(bad, { jobTtlMs: 1000 });
    const r = await upload(a, readFileSync(makeMp3({ seconds: 3 })));
    const v = await waitDone(a, r.json().id);
    expect(v.status).toBe('partial');
    expect(await j.tmpDirCount()).toBe(1);
    await j.sweep(Date.now() + 5000);
    expect(await j.tmpDirCount()).toBe(0);
  });
});

describe('LLM API', () => {
  it('校正候補・整文・議事録', async () => {
    const { app: a } = await setup();
    const p = await a.inject({ method: 'POST', url: '/api/llm/proofread', headers: AUTH, payload: { text: '足ポンプを機械式に変更した' } });
    expect(p.json().candidates[0]).toMatchObject({ original: '足ポンプ', suggestion: 'アッシュポンプ', source: 'ai' });
    const q = await a.inject({ method: 'POST', url: '/api/llm/polish', headers: AUTH, payload: { text: 'えー、確認しました' } });
    expect(q.json().text).toBe('確認しました');
    const g = await a.inject({ method: 'POST', url: '/api/llm/generate', headers: AUTH, payload: { kind: 'minutes', text: '本文' } });
    expect(g.statusCode).toBe(200);
    const bad = await a.inject({ method: 'POST', url: '/api/llm/generate', headers: AUTH, payload: { kind: 'nope', text: 'x' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('/share-target フォールバック', () => {
  it('SW未制御のPOSTは保存せず303でリダイレクト', async () => {
    const { app: a, jobs: j } = await setup();
    const m = multipartBody(Buffer.from('ID3xxxx'));
    const r = await a.inject({ method: 'POST', url: '/share-target', payload: m.body, headers: m.headers });
    expect(r.statusCode).toBe(303);
    expect(r.headers.location).toBe('/?share_error=nosw');
    expect(await j.tmpDirCount()).toBe(0);
  });
});
