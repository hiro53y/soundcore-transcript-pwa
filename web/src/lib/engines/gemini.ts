import {
  POLISH_CHUNK,
  PROOFREAD_CHUNK,
  formatClock,
  generateInstructions,
  polishInstructions,
  proofreadInstructions,
  sanitizeCandidates,
  splitForLlm,
  InvalidCandidatesError,
  type CorrectionCandidate,
  type DictionaryContext,
} from '@app/shared';
import { EngineError, type TextEngine, type TranscribeEngine, type TranscribeInput } from './types';

/**
 * Google Gemini API をブラウザから直接呼ぶエンジン（サーバー不要・無料枠で利用可）。
 * - キーは利用者自身が Google AI Studio で取得したもの。この端末のIndexedDBにのみ保存し、
 *   ヘッダ(x-goog-api-key)でのみ送る。URL・ログ・エラーメッセージには含めない。
 * - 無料枠は入力が Google の製品改善に使われる場合がある（UIで必ず注意表示）。
 */
const BASE = 'https://generativelanguage.googleapis.com';
export const GEMINI_WINDOW_SEC = 20 * 60;
const INLINE_MAX_BYTES = 14 * 1024 * 1024; // base64化して20MB(リクエスト上限)に収まる目安

export interface GeminiOptions {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  /** テスト用。再試行待ちの基準ミリ秒。 */
  retryBaseMs?: number;
  maxAttempts?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function requireKey(o: GeminiOptions): void {
  if (!o.apiKey.trim()) throw new EngineError('Geminiを使うには、設定画面でGoogle AI StudioのAPIキーを入力してください。');
}

class HttpFail extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`HTTP ${status}`);
  }
}

async function failFromResponse(res: Response): Promise<HttpFail> {
  let detail = '';
  try {
    const b = (await res.json()) as { error?: { message?: string; status?: string } };
    detail = b?.error?.status ?? '';
    if (/API key not valid|API_KEY_INVALID/i.test(b?.error?.message ?? '')) detail = 'API_KEY_INVALID';
  } catch {
    /* 本文なし */
  }
  return new HttpFail(res.status, detail);
}

/** HTTP失敗 → 利用者向け日本語メッセージ。 */
export function geminiErrorMessage(f: HttpFail): string {
  if (f.detail === 'API_KEY_INVALID' || f.status === 401) return 'GeminiのAPIキーが正しくありません。設定画面で入力し直してください。';
  if (f.status === 403) return 'Geminiの利用が許可されませんでした（キーの権限・利用地域・無料枠の対象外の可能性）。';
  if (f.status === 404) return '指定したGeminiのモデルが見つかりません。設定画面でモデル名を確認してください。';
  if (f.status === 429) return 'Geminiの無料枠の回数・量の上限に達しました。しばらく（目安: 1分〜翌日）待ってから再試行してください。';
  if (f.status === 400) return 'Geminiがリクエストを受け付けませんでした。音声の形式や長さを確認してください。';
  if (f.status >= 500) return 'Geminiのサーバーが一時的に利用できません。しばらくして再試行してください。';
  return `Geminiでエラーが発生しました（HTTP ${f.status}）。`;
}

const retryable = (f: HttpFail) => f.status === 429 || f.status >= 500;

/** 一時的エラー(429/5xx)は指数バックオフで再試行する。 */
async function withRetry<T>(o: GeminiOptions, fn: () => Promise<T>, onWait?: (sec: number) => void): Promise<T> {
  const max = o.maxAttempts ?? 3;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof HttpFail) {
        if (retryable(e) && attempt < max) {
          const wait = (o.retryBaseMs ?? 5000) * 2 ** (attempt - 1);
          onWait?.(Math.round(wait / 1000));
          await sleep(wait);
          continue;
        }
        throw new EngineError(geminiErrorMessage(e));
      }
      if (e instanceof EngineError) throw e;
      throw new EngineError('Googleのサーバーへ接続できませんでした。通信状況を確認して再試行してください。', { cause: e });
    }
  }
}

function headers(o: GeminiOptions, extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-goog-api-key': o.apiKey.trim(), ...extra };
}

type Part = { text: string } | { fileData: { mimeType: string; fileUri: string } } | { inlineData: { mimeType: string; data: string } };

interface GenerateArgs {
  system?: string;
  parts: Part[];
  json?: { schema: Record<string, unknown> };
}

async function generateOnce(o: GeminiOptions, a: GenerateArgs): Promise<string> {
  const f = o.fetchImpl ?? fetch;
  const body: Record<string, unknown> = { contents: [{ role: 'user', parts: a.parts }] };
  if (a.system) body.systemInstruction = { parts: [{ text: a.system }] };
  if (a.json) body.generationConfig = { responseMimeType: 'application/json', responseSchema: a.json.schema };
  const res = await f(`${BASE}/v1beta/models/${encodeURIComponent(o.model)}:generateContent`, {
    method: 'POST',
    headers: headers(o, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await failFromResponse(res);
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };
  const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  if (!text.trim()) {
    const why = data.promptFeedback?.blockReason ? '（安全フィルタにより拒否されました）' : '';
    throw new EngineError(`Geminiから結果が返りませんでした${why}。もう一度お試しください。`);
  }
  return text;
}

const generate = (o: GeminiOptions, a: GenerateArgs, onWait?: (s: number) => void) => withRetry(o, () => generateOnce(o, a), onWait);

// ---------------- Files API ----------------

interface UploadedFile {
  part: Part;
  cleanup: () => Promise<void>;
}

export function audioMime(blob: Blob): string {
  return blob.type.startsWith('audio/') ? blob.type : 'audio/mpeg';
}

async function toBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function uploadFile(o: GeminiOptions, blob: Blob): Promise<UploadedFile> {
  const f = o.fetchImpl ?? fetch;
  const mime = audioMime(blob);
  try {
    const start = await withRetry(o, async () => {
      const res = await f(`${BASE}/upload/v1beta/files`, {
        method: 'POST',
        headers: headers(o, {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(blob.size),
          'X-Goog-Upload-Header-Content-Type': mime,
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ file: { display_name: 'meeting-audio' } }),
      });
      if (!res.ok) throw await failFromResponse(res);
      return res.headers.get('x-goog-upload-url');
    });
    if (!start) throw new EngineError('アップロード先を取得できませんでした。', { cause: new Error('upload url not exposed') });
    const up = await withRetry(o, async () => {
      const res = await f(start, {
        method: 'POST',
        headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
        body: blob,
      });
      if (!res.ok) throw await failFromResponse(res);
      return (await res.json()) as { file?: { uri?: string; name?: string; state?: string; mimeType?: string } };
    });
    const file = up.file;
    if (!file?.uri || !file.name) throw new Error('bad upload response');
    // 処理中なら有効になるまで待つ（音声は通常すぐ）
    let state = file.state;
    for (let i = 0; state === 'PROCESSING' && i < 60; i++) {
      await sleep(o.retryBaseMs === undefined ? 1000 : 1);
      const res = await f(`${BASE}/v1beta/${file.name}`, { headers: headers(o) });
      if (!res.ok) break;
      state = ((await res.json()) as { state?: string }).state;
    }
    if (state === 'FAILED') throw new EngineError('Googleでの音声の準備に失敗しました。別の形式で再試行してください。');
    return {
      part: { fileData: { mimeType: file.mimeType ?? mime, fileUri: file.uri } },
      cleanup: async () => {
        try {
          await f(`${BASE}/v1beta/${file.name}`, { method: 'DELETE', headers: headers(o) });
        } catch {
          /* 48時間で自動削除される */
        }
      },
    };
  } catch (e) {
    // 認証・上限などHTTP判定済みのエラー(causeなし)はそのまま利用者へ。通信/CORS等の技術的失敗だけフォールバックを試す
    if (e instanceof EngineError && e.cause === undefined) throw e;
    if (blob.size <= INLINE_MAX_BYTES) {
      return { part: { inlineData: { mimeType: mime, data: await toBase64(blob) } }, cleanup: async () => undefined };
    }
    throw new EngineError('Googleへの音声アップロードに失敗しました。端末内方式（Whisper）に切り替えるか、通信状況を確認して再試行してください。', { cause: e });
  }
}

// ---------------- 文字起こし ----------------

/** 区間の時刻見出しを `[hh:mm:ss]`（音声全体の先頭からの時刻）へ正規化する。見出しが無ければ区間先頭を補う。 */
export function normalizeStamps(text: string, windowStartSec: number): string {
  let found = false;
  const lines = text
    .trim()
    .split('\n')
    .map((line) => {
      const m = /^\s*[[(]?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[\])]?\s*(.*)$/.exec(line);
      if (!m) return line;
      found = true;
      const sec = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      const rest = m[4] ?? '';
      return rest ? `[${formatClock(sec)}]\n${rest}` : `[${formatClock(sec)}]`;
    });
  const body = lines.join('\n');
  return found ? body : `[${formatClock(windowStartSec)}]\n${body}`;
}

export function mmss(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function transcribePrompt(range: { from: number; to: number } | undefined, dict?: DictionaryContext): string {
  const where = range ? `音声の ${mmss(range.from)} から ${mmss(range.to)} までの部分だけ` : '音声全体';
  const terms = dict?.terms.length ? `\n専門用語（表記の参考。該当する発言にだけ使う）: ${dict.terms.map((t) => t.term).join('、')}` : '';
  return `${where}を、聞こえたとおりに日本語で文字起こししてください。
- 要約・言い換え・補足・推測はしない。言い淀みもできるだけそのまま書く。
- 聞き取れない箇所は【聞き取り不明】と書く。数字・固有名詞は聞こえたとおりに書く。
- 約1分ごと、または話題・話者が変わるごとに改行し、行頭に音声全体の先頭からの開始時刻を [hh:mm:ss] の形式で付ける。
- 出力は文字起こし本文のみ（前置き・説明は不要）。${terms}`;
}

export function geminiTranscribeEngine(o: GeminiOptions): TranscribeEngine {
  return {
    id: 'gemini',
    preflight: () => (o.apiKey.trim() ? undefined : 'Geminiを使うには、設定画面でGoogle AI StudioのAPIキーを入力してください。'),
    async transcribe(input: TranscribeInput): Promise<string> {
      requireKey(o);
      if (!input.blob) throw new EngineError('音声データが端末にありません。もう一度MP3を選択してください。');
      input.onProgress({ label: 'Googleへ音声をアップロード中' });
      const file = await uploadFile(o, input.blob);
      try {
        const dur = input.durationSec;
        const windows: ({ from: number; to: number } | undefined)[] = [];
        if (dur === undefined || dur <= GEMINI_WINDOW_SEC * 1.25) windows.push(undefined);
        else for (let from = 0; from < dur; from += GEMINI_WINDOW_SEC) windows.push({ from, to: Math.min(dur, from + GEMINI_WINDOW_SEC) });
        const out: string[] = [];
        for (let i = 0; i < windows.length; i++) {
          const w = windows[i];
          input.onProgress({
            label: windows.length > 1 ? `Geminiで文字起こし中（${i + 1}/${windows.length}区間）` : 'Geminiで文字起こし中',
            ratio: windows.length > 1 ? i / windows.length : undefined,
            chunks: { done: i, total: windows.length },
          });
          let text: string;
          try {
            text = await generate(o, { parts: [{ text: transcribePrompt(w, input.dictionary) }, file.part] }, (s) =>
              input.onProgress({ label: `Geminiの混雑のため${s}秒待って再試行します…` }),
            );
          } catch (e) {
            if (e instanceof EngineError && w) throw new EngineError(`${mmss(w.from)}〜${mmss(w.to)}の区間で失敗しました。${e.message}`, { cause: e });
            throw e;
          }
          out.push(normalizeStamps(text, w?.from ?? 0));
        }
        return out.join('\n\n');
      } finally {
        await file.cleanup(); // 成功・失敗どちらでもGoogle側の一時ファイルを削除
      }
    },
  };
}

// ---------------- 整文・校正・生成 ----------------

const PROOFREAD_SCHEMA_GEMINI = {
  type: 'OBJECT',
  properties: {
    candidates: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          original: { type: 'STRING' },
          suggestion: { type: 'STRING' },
          reason: { type: 'STRING' },
          confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
        },
        required: ['original', 'suggestion', 'reason', 'confidence'],
      },
    },
  },
  required: ['candidates'],
};

export function geminiTextEngine(o: GeminiOptions): TextEngine {
  return {
    id: 'gemini',
    async proofread(text: string, dict?: DictionaryContext): Promise<CorrectionCandidate[]> {
      requireKey(o);
      const all: CorrectionCandidate[] = [];
      const seen = new Set<string>();
      for (const part of splitForLlm(text, PROOFREAD_CHUNK)) {
        const raw = await generate(o, { system: proofreadInstructions(dict), parts: [{ text: part }], json: { schema: PROOFREAD_SCHEMA_GEMINI } });
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new EngineError('Geminiの校正結果を読み取れませんでした。もう一度お試しください。');
        }
        try {
          for (const c of sanitizeCandidates(parsed, part)) {
            const k = `${c.original}\u0000${c.suggestion}`;
            if (seen.has(k)) continue;
            seen.add(k);
            all.push(c);
          }
        } catch (e) {
          if (e instanceof InvalidCandidatesError) throw new EngineError('Geminiの校正結果の形式が不正でした。もう一度お試しください。');
          throw e;
        }
      }
      return all;
    },
    async polish(text, dict) {
      requireKey(o);
      const parts: string[] = [];
      for (const part of splitForLlm(text, POLISH_CHUNK)) {
        parts.push((await generate(o, { system: polishInstructions(dict), parts: [{ text: part }] })).trim());
      }
      return { text: parts.join('\n\n'), model: o.model };
    },
    async generate(kind, text, title, dict) {
      requireKey(o);
      const out = await generate(o, { system: generateInstructions(kind, title, dict), parts: [{ text }] });
      return { text: out.trim(), model: o.model };
    },
  };
}

/** 設定画面の接続テスト。モデル情報の取得だけを行い、課金・生成は発生しない。 */
export async function testGeminiConnection(o: GeminiOptions): Promise<string> {
  requireKey(o);
  const f = o.fetchImpl ?? fetch;
  try {
    const res = await f(`${BASE}/v1beta/models/${encodeURIComponent(o.model)}`, { headers: headers(o) });
    if (!res.ok) throw new EngineError(geminiErrorMessage(await failFromResponse(res)));
    return 'OK：Geminiに接続できました。';
  } catch (e) {
    if (e instanceof EngineError) throw e;
    throw new EngineError('Googleのサーバーへ接続できませんでした。通信状況を確認してください。', { cause: e });
  }
}
