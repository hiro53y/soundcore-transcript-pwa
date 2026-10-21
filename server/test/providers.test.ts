import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LlmService, sanitizeCandidates, splitForLlm } from '../src/llm/service.js';
import { OpenAILlmProvider, OpenAITranscriptionProvider, dictionaryToPrompt } from '../src/providers/openai.js';
import { MockLlmProvider } from '../src/providers/mock.js';
import { testConfig } from './helpers.js';

const file = path.join(os.tmpdir(), 'prov-test.mp3');
writeFileSync(file, Buffer.from('ID3....'));
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const dict = { terms: [{ term: 'CGL', misrecognitions: ['シージーエル'] }] };

describe('OpenAITranscriptionProvider', () => {
  it('gpt-transcribe: languages[]/keywords[] を送りtextを返す。APIキーはAuthorizationのみ', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const p = new OpenAITranscriptionProvider(testConfig({ transcribeModel: 'gpt-transcribe' }), async (url, init) => {
      seen = { url: String(url), init: init! };
      return json(200, { text: 'こんにちは' });
    });
    expect(await p.transcribe(file, { chunkIndex: 0, dictionary: dict })).toEqual({ text: 'こんにちは' });
    expect(seen!.url).toMatch(/\/audio\/transcriptions$/);
    const form = seen!.init.body as FormData;
    expect(form.get('model')).toBe('gpt-transcribe');
    expect(form.getAll('languages[]')).toEqual(['ja']);
    expect(form.getAll('keywords[]')).toEqual(['CGL']);
    expect(form.get('language')).toBeNull();
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });
  it('gpt-transcribe が400なら keywords 無しで1回だけ再試行する', async () => {
    let n = 0;
    const p = new OpenAITranscriptionProvider(testConfig(), async (_u, init) => {
      n++;
      const f = init!.body as FormData;
      if (f.has('keywords[]')) return json(400, { error: { code: 'unknown_parameter' } });
      return json(200, { text: 'ok' });
    });
    expect((await p.transcribe(file, { chunkIndex: 0, dictionary: dict })).text).toBe('ok');
    expect(n).toBe(2);
  });
  it('4o系は language と prompt を使う', async () => {
    let form: FormData | undefined;
    const p = new OpenAITranscriptionProvider(testConfig({ transcribeModel: 'gpt-4o-transcribe' }), async (_u, init) => {
      form = init!.body as FormData;
      return json(200, { text: 'x' });
    });
    await p.transcribe(file, { chunkIndex: 0, dictionary: dict });
    expect(form!.get('language')).toBe('ja');
    expect(String(form!.get('prompt'))).toContain('CGL');
  });
  it.each([
    [401, {}, 'provider_auth_failed'],
    [429, { error: { code: 'insufficient_quota' } }, 'quota_exceeded'],
    [429, { error: { code: 'rate_limit_exceeded' } }, 'rate_limited'],
    [500, {}, 'provider_error'],
    [413, {}, 'file_too_large'],
  ])('HTTP %i → %s', async (status, body, code) => {
    const p = new OpenAITranscriptionProvider(testConfig(), async () => json(status, body));
    await expect(p.transcribe(file, { chunkIndex: 0 })).rejects.toMatchObject({ code });
  });
  it('タイムアウト・通信断・キー未設定', async () => {
    const t = new OpenAITranscriptionProvider(testConfig(), async () => {
      throw Object.assign(new Error('x'), { name: 'TimeoutError' });
    });
    await expect(t.transcribe(file, { chunkIndex: 0 })).rejects.toMatchObject({ code: 'timeout' });
    const n = new OpenAITranscriptionProvider(testConfig(), async () => {
      throw new TypeError('fetch failed');
    });
    await expect(n.transcribe(file, { chunkIndex: 0 })).rejects.toMatchObject({ code: 'provider_error', retryable: true });
    const k = new OpenAITranscriptionProvider(testConfig({ openaiApiKey: '' }), async () => json(200, {}));
    await expect(k.transcribe(file, { chunkIndex: 0 })).rejects.toMatchObject({ code: 'api_key_missing' });
  });
  it('想定外の応答形式', async () => {
    const p = new OpenAITranscriptionProvider(testConfig(), async () => json(200, { nope: 1 }));
    await expect(p.transcribe(file, { chunkIndex: 0 })).rejects.toMatchObject({ code: 'provider_error' });
  });
});

describe('OpenAILlmProvider', () => {
  it('Responses API に json_schema(strict) とモデル名を渡し、output を解釈する', async () => {
    let payload: Record<string, unknown> = {};
    const p = new OpenAILlmProvider(testConfig(), async (_u, init) => {
      payload = JSON.parse(String(init!.body));
      return json(200, { output: [{ type: 'message', content: [{ type: 'output_text', text: '{"candidates":[]}' }] }] });
    });
    const r = await p.generateJson({ task: 'proofread', model: 'm-x', instructions: 'i', input: 'in', schemaName: 's', schema: { type: 'object' } });
    expect(r).toEqual({ candidates: [] });
    expect(payload.model).toBe('m-x');
    expect(payload.store).toBe(false);
    expect((payload.text as { format: { strict: boolean; type: string } }).format).toMatchObject({ type: 'json_schema', strict: true });
  });
  it('エラー変換とJSON不正', async () => {
    const e = new OpenAILlmProvider(testConfig(), async () => json(429, { error: { code: 'rate_limit_exceeded' } }));
    await expect(e.generateText({ task: 'polish', model: 'm', instructions: 'i', input: 'x' })).rejects.toMatchObject({ code: 'rate_limited' });
    const j = new OpenAILlmProvider(testConfig(), async () => json(200, { output_text: 'not json' }));
    await expect(j.generateJson({ task: 'proofread', model: 'm', instructions: 'i', input: 'x', schemaName: 's', schema: {} })).rejects.toMatchObject({ code: 'provider_error' });
  });
});

describe('LlmService / 校正候補の検証', () => {
  it('本文に存在しない original（幻覚）や同一表記・重複を捨てる', () => {
    const raw = {
      candidates: [
        { original: '足ポンプ', suggestion: 'アッシュポンプ', reason: 'r', confidence: 'high' },
        { original: '存在しない語', suggestion: 'X', reason: 'r', confidence: 'high' },
        { original: '足ポンプ', suggestion: 'アッシュポンプ', reason: 'dup', confidence: 'low' },
        { original: '機械式', suggestion: '機械式', reason: 'same', confidence: 'low' },
        { original: '機械式', suggestion: 'メカ式', reason: 'r', confidence: 'weird' },
      ],
    };
    const out = sanitizeCandidates(raw, '足ポンプを機械式に変更した');
    expect(out.map((c) => c.suggestion)).toEqual(['アッシュポンプ', 'メカ式']);
    expect(out[1]!.confidence).toBe('low');
  });
  it('長文は段落境界で分割し、polishは各チャンクを順に処理して結合', async () => {
    const text = Array.from({ length: 30 }, (_, i) => `段落${i}。`.repeat(150)).join('\n\n');
    const parts = splitForLlm(text, 6000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 6000)).toBe(true);
    const svc = new LlmService(new MockLlmProvider(), testConfig());
    const r = await svc.polish(text);
    expect(r.text.length).toBeGreaterThan(text.length * 0.9);
  });
  it('生成種別ごとにモデルを切り替える', async () => {
    const svc = new LlmService(new MockLlmProvider(), testConfig({ llmModel: 'big', llmModelLight: 'small' }));
    expect((await svc.generate('minutes', 'x')).model).toBe('big');
    expect((await svc.generate('summary', 'x')).model).toBe('small');
  });
});

describe('dictionaryToPrompt', () => {
  it('上限文字数で切り詰める', () => {
    const d = { terms: Array.from({ length: 100 }, (_, i) => ({ term: `用語${i}`, misrecognitions: [] })) };
    expect(dictionaryToPrompt(d, 50).length).toBeLessThanOrEqual(50);
    expect(dictionaryToPrompt(undefined, 50)).toBe('');
  });
});
