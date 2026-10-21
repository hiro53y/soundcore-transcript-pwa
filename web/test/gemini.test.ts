import { describe, expect, it, vi } from 'vitest';
import { GEMINI_WINDOW_SEC, geminiTextEngine, geminiTranscribeEngine, mmss, normalizeStamps, testGeminiConnection, type GeminiOptions } from '../src/lib/engines/gemini';
import { EngineError } from '../src/lib/engines/types';

const KEY = 'AIza-SECRET-KEY-123';
type Call = { url: string; init: RequestInit };

function gen(text: string) {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }), { status: 200 });
}
const err = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

function mockFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call);
  });
  return { f: f as unknown as typeof fetch, calls };
}
const opts = (fetchImpl: typeof fetch, over: Partial<GeminiOptions> = {}): GeminiOptions => ({ apiKey: KEY, model: 'gemini-test', fetchImpl, retryBaseMs: 1, ...over });
const body = (c: Call) => JSON.parse(String(c.init.body));
const audio = new Blob([new Uint8Array(1000)], { type: 'audio/mpeg' });
const baseInput = { recordId: 'r', blob: audio, onProgress: () => undefined };

/** Files API を成功させるモック。generate 応答は引数で差し替え。 */
function filesRouter(onGenerate: (c: Call) => Response | Promise<Response>) {
  return (c: Call) => {
    if (c.url.endsWith('/upload/v1beta/files')) return new Response('{}', { status: 200, headers: { 'x-goog-upload-url': 'https://upload.example/u1' } });
    if (c.url === 'https://upload.example/u1') return new Response(JSON.stringify({ file: { uri: 'https://g/files/abc', name: 'files/abc', state: 'ACTIVE', mimeType: 'audio/mpeg' } }), { status: 200 });
    if (c.init.method === 'DELETE') return new Response('{}', { status: 200 });
    if (c.url.includes(':generateContent')) return onGenerate(c);
    return err(404);
  };
}

describe('Gemini 文字起こし', () => {
  it('Files APIへアップロード→文字起こし→Google側のファイルを削除。キーはヘッダのみでURL/本文に出ない', async () => {
    const m = mockFetch(filesRouter(() => gen('えー、こんにちは。')));
    const text = await geminiTranscribeEngine(opts(m.f)).transcribe({ ...baseInput, durationSec: 60 });
    expect(text).toBe('[00:00:00]\nえー、こんにちは。');
    const urls = m.calls.map((c) => c.url);
    expect(urls[0]).toMatch(/\/upload\/v1beta\/files$/);
    expect(m.calls[0]!.init.headers).toMatchObject({ 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start' });
    const g = m.calls.find((c) => c.url.includes(':generateContent'))!;
    expect(g.url).toContain('/v1beta/models/gemini-test:generateContent');
    expect(body(g).contents[0].parts[1]).toEqual({ fileData: { mimeType: 'audio/mpeg', fileUri: 'https://g/files/abc' } });
    expect(body(g).contents[0].parts[0].text).toContain('音声全体');
    expect(m.calls.some((c) => c.init.method === 'DELETE' && c.url.endsWith('files/abc'))).toBe(true);
    for (const c of m.calls) {
      expect(c.url).not.toContain(KEY);
      expect(String(c.init.body ?? '')).not.toContain(KEY);
      if (c.url.includes('generativelanguage')) expect((c.init.headers as Record<string, string>)['x-goog-api-key']).toBe(KEY);
    }
  });

  it('長い音声は20分ごとの時間範囲で順次文字起こしし、見出し時刻を音声全体基準に正規化する', async () => {
    const prompts: string[] = [];
    const m = mockFetch(
      filesRouter((c) => {
        const p = body(c).contents[0].parts[0].text as string;
        prompts.push(p);
        return gen(prompts.length === 1 ? '[00:05] 最初' : prompts.length === 2 ? '[1:02] 二番目' : '見出し無し');
      }),
    );
    const text = await geminiTranscribeEngine(opts(m.f)).transcribe({ ...baseInput, durationSec: 3000 });
    expect(prompts).toHaveLength(3);
    expect(prompts[0]).toContain('00:00 から 20:00');
    expect(prompts[1]).toContain('20:00 から 40:00');
    expect(prompts[2]).toContain('40:00 から 50:00');
    expect(text).toBe('[00:00:05]\n最初\n\n[00:01:02]\n二番目\n\n[00:40:00]\n見出し無し');
    expect(GEMINI_WINDOW_SEC).toBe(1200);
  });

  it('途中の区間で失敗しても、Google側の一時ファイルは削除され、どの区間か分かる', async () => {
    let n = 0;
    const m = mockFetch(filesRouter(() => (++n === 2 ? err(400) : gen('ok'))));
    await expect(geminiTranscribeEngine(opts(m.f)).transcribe({ ...baseInput, durationSec: 3000 })).rejects.toThrow(/20:00〜40:00の区間で失敗/);
    expect(m.calls.some((c) => c.init.method === 'DELETE')).toBe(true);
  });

  it('429は指数バックオフで再試行して成功できる。続けて失敗すれば日本語メッセージ', async () => {
    let n = 0;
    const ok = mockFetch(filesRouter(() => (++n < 3 ? err(429) : gen('成功'))));
    expect(await geminiTranscribeEngine(opts(ok.f)).transcribe({ ...baseInput, durationSec: 10 })).toContain('成功');
    const ng = mockFetch(filesRouter(() => err(429)));
    await expect(geminiTranscribeEngine(opts(ng.f, { maxAttempts: 2 })).transcribe({ ...baseInput, durationSec: 10 })).rejects.toThrow(/無料枠の回数・量の上限/);
  });

  it('キー無効・キー未設定・通信断・安全フィルタの日本語メッセージ', async () => {
    const bad = mockFetch((c) => (c.url.includes('upload/v1beta') ? err(400, { error: { message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }) : err(404)));
    await expect(geminiTranscribeEngine(opts(bad.f)).transcribe(baseInput)).rejects.toThrow('APIキーが正しくありません');
    const none = mockFetch(() => err(500));
    await expect(geminiTranscribeEngine(opts(none.f, { apiKey: ' ' })).transcribe(baseInput)).rejects.toThrow('APIキーを入力してください');
    expect(geminiTranscribeEngine(opts(none.f, { apiKey: '' })).preflight?.({})).toContain('APIキー');
    expect(none.calls).toHaveLength(0);
    const net = mockFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const e = await geminiTranscribeEngine(opts(net.f)).transcribe({ ...baseInput, blob: new Blob([new Uint8Array(20 * 1024 * 1024)], { type: 'audio/mpeg' }) }).catch((x) => x);
    expect(e).toBeInstanceOf(EngineError);
    expect(e.message).toMatch(/アップロードに失敗|接続できません/);
    const blocked = mockFetch(filesRouter(() => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 })));
    await expect(geminiTranscribeEngine(opts(blocked.f)).transcribe({ ...baseInput, durationSec: 5 })).rejects.toThrow(/安全フィルタ/);
  });

  it('Files APIのアップロード先が取得できない環境では、小さい音声のみインライン送信にフォールバック', async () => {
    const m = mockFetch((c) => {
      if (c.url.includes('upload/v1beta')) return new Response('{}', { status: 200 }); // x-goog-upload-url が見えない(CORS等)
      return gen('インライン');
    });
    const text = await geminiTranscribeEngine(opts(m.f)).transcribe({ ...baseInput, durationSec: 5 });
    expect(text).toContain('インライン');
    const g = m.calls.find((c) => c.url.includes(':generateContent'))!;
    expect(body(g).contents[0].parts[1].inlineData.mimeType).toBe('audio/mpeg');
    expect(typeof body(g).contents[0].parts[1].inlineData.data).toBe('string');
  });

  it('辞書の用語をプロンプトに含める', async () => {
    const m = mockFetch(filesRouter(() => gen('x')));
    await geminiTranscribeEngine(opts(m.f)).transcribe({ ...baseInput, durationSec: 5, dictionary: { terms: [{ term: 'CGL', misrecognitions: [] }] } });
    expect(body(m.calls.find((c) => c.url.includes(':generateContent'))!).contents[0].parts[0].text).toContain('CGL');
  });
});

describe('Gemini 整文・校正・生成', () => {
  it('校正候補はJSONスキーマ付きで要求し、本文に無い候補は捨てる。キーは本文に含めない', async () => {
    const m = mockFetch(() => gen(JSON.stringify({ candidates: [{ original: '足ポンプ', suggestion: 'アッシュポンプ', reason: '設備名', confidence: 'medium' }, { original: '存在しない', suggestion: 'X', reason: '', confidence: 'high' }] })));
    const out = await geminiTextEngine(opts(m.f)).proofread('足ポンプを変更した');
    expect(out.map((c) => c.suggestion)).toEqual(['アッシュポンプ']);
    expect(out[0]!.source).toBe('ai');
    const b = body(m.calls[0]!);
    expect(b.generationConfig.responseMimeType).toBe('application/json');
    expect(b.generationConfig.responseSchema.type).toBe('OBJECT');
    expect(b.systemInstruction.parts[0].text).toContain('創作しない');
    expect(JSON.stringify(b)).not.toContain(KEY);
  });

  it('JSONでない応答は日本語エラー', async () => {
    const m = mockFetch(() => gen('これはJSONではない'));
    await expect(geminiTextEngine(opts(m.f)).proofread('本文')).rejects.toThrow('読み取れませんでした');
  });

  it('整文は長文を分割して順に処理し結合。議事録は共通の創作禁止指示を使う', async () => {
    const m = mockFetch((c) => gen(`out${m.calls.indexOf(c)}`));
    const long = Array.from({ length: 30 }, (_, i) => `段落${i}。`.repeat(150)).join('\n\n');
    const r = await geminiTextEngine(opts(m.f)).polish(long);
    expect(m.calls.length).toBeGreaterThan(1);
    expect(r.model).toBe('gemini-test');
    const g = await geminiTextEngine(opts(m.f)).generate('minutes', '本文', 'タイトル');
    const last = body(m.calls.at(-1)!);
    expect(last.systemInstruction.parts[0].text).toContain('議題');
    expect(last.systemInstruction.parts[0].text).toContain('入力（文字起こし）に書かれていない事実');
    expect(g.text).toMatch(/^out/);
  });

  it('接続テストは課金されない軽量なモデル情報取得のみ', async () => {
    const m = mockFetch(() => new Response('{}', { status: 200 }));
    expect(await testGeminiConnection(opts(m.f))).toContain('OK');
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.url).toMatch(/\/v1beta\/models\/gemini-test$/);
    const ng = mockFetch(() => err(403));
    await expect(testGeminiConnection(opts(ng.f))).rejects.toThrow('許可されませんでした');
  });
});

describe('時刻見出し', () => {
  it('[mm:ss]/[h:mm:ss]/行頭の時刻を [hh:mm:ss] へ', () => {
    expect(normalizeStamps('[00:05] あ\n1:02:03 い', 0)).toBe('[00:00:05]\nあ\n[01:02:03]\nい');
    expect(normalizeStamps('見出し無し', 1200)).toBe('[00:20:00]\n見出し無し');
    expect(mmss(3725)).toBe('62:05');
  });
});
