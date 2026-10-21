import type { WhisperSize } from '../types';
import { EngineError, type TranscribeEngine, type TranscribeInput } from './types';
import {
  LOCAL_MAX_SEC,
  ORT_WASM_MB,
  SAMPLE_RATE,
  WHISPER_MODELS,
  cleanChunks,
  formatChunks,
  isSilent,
  planSegments,
  type RawChunk,
  type WorkerIn,
  type WorkerLike,
} from './whisperCore';

/** 音声を 16kHz モノラルの Float32 にデコードする（ブラウザ標準のAudioContext）。 */
export async function decodeTo16kMono(blob: Blob): Promise<Float32Array> {
  const Ctx = (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctx) throw new EngineError('この端末のブラウザは音声のデコードに対応していません。Chromeの最新版をお使いください。');
  const ctx = new Ctx({ sampleRate: SAMPLE_RATE });
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const mono = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < buf.length; i++) mono[i]! += ch[i]! / buf.numberOfChannels;
    }
    return mono;
  } catch (cause) {
    throw new EngineError('音声をデコードできませんでした。ファイルが壊れているか、対応していない形式の可能性があります。', { cause });
  } finally {
    void ctx.close();
  }
}

export interface LocalDeps {
  createWorker: () => WorkerLike;
  decode: (blob: Blob) => Promise<Float32Array>;
  basePath: string;
  useGpu: boolean;
}

function defaultWorker(): WorkerLike {
  return new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
}

export function defaultLocalDeps(useGpu = false): LocalDeps {
  return { createWorker: defaultWorker, decode: decodeTo16kMono, basePath: import.meta.env.BASE_URL, useGpu };
}

/** モデルが端末にダウンロード済みか（設定画面の表示用）。 */
export async function isWhisperCached(size: WhisperSize): Promise<boolean> {
  try {
    if (typeof caches === 'undefined') return false;
    const cache = await caches.open('transformers-cache');
    const keys = await cache.keys();
    const id = WHISPER_MODELS[size].id;
    return keys.some((r) => r.url.includes(id) && r.url.includes('decoder_model_merged'));
  } catch {
    return false;
  }
}

export async function deleteWhisperCache(size: WhisperSize): Promise<void> {
  const cache = await caches.open('transformers-cache');
  const id = WHISPER_MODELS[size].id;
  for (const r of await cache.keys()) if (r.url.includes(id)) await cache.delete(r);
}

/** 初回ダウンロードの目安メッセージ。 */
export function downloadHint(size: WhisperSize, cached: boolean): string {
  return cached ? '' : `初回のみ、モデル（約${WHISPER_MODELS[size].approxMb}MB）と実行エンジン（約${ORT_WASM_MB}MB）をダウンロードします。Wi-Fi接続を推奨します。`;
}

export function localTranscribeEngine(size: WhisperSize, deps: LocalDeps = defaultLocalDeps()): TranscribeEngine {
  return {
    id: 'local',
    preflight: (i) =>
      i.durationSec !== undefined && i.durationSec > LOCAL_MAX_SEC
        ? `この音声は${Math.round(i.durationSec / 60)}分あり、端末内処理の上限（${LOCAL_MAX_SEC / 60}分）を超えています。設定で「Google Gemini」に切り替えるか、音声を分割してください。`
        : undefined,
    async transcribe(input: TranscribeInput): Promise<string> {
      if (!input.blob) throw new EngineError('音声データが端末にありません。もう一度MP3を選択してください。');
      input.onProgress({ label: '音声を読み込み中' });
      const audio = await deps.decode(input.blob);
      if (audio.length / SAMPLE_RATE > LOCAL_MAX_SEC * 1.05) {
        throw new EngineError(`端末内処理の上限（${LOCAL_MAX_SEC / 60}分）を超えています。「Google Gemini」へ切り替えてください。`);
      }
      const worker = deps.createWorker();
      try {
        const chunks = await runWorker(worker, deps, WHISPER_MODELS[size].id, audio, input);
        const text = formatChunks(cleanChunks(chunks));
        return text || '（音声から文字を検出できませんでした）';
      } finally {
        worker.terminate();
      }
    },
  };
}

function runWorker(worker: WorkerLike, deps: LocalDeps, modelId: string, audio: Float32Array, input: TranscribeInput): Promise<RawChunk[]> {
  return new Promise((resolve, reject) => {
    const segments = planSegments(audio);
    const out: RawChunk[] = [];
    let idx = 0;
    const fail = (msg: string, cause?: unknown) => reject(new EngineError(msg, { cause }));
    const next = () => {
      // 無音区間は幻覚防止のためモデルに渡さない
      while (idx < segments.length && isSilent(audio.subarray(segments[idx]![0], segments[idx]![1]))) idx++;
      if (idx >= segments.length) return resolve(out);
      const [s, e] = segments[idx]!;
      input.onProgress({
        label: `端末内で文字起こし中（${idx + 1}/${segments.length}区間）`,
        ratio: idx / segments.length,
        chunks: { done: idx, total: segments.length },
      });
      const slice = audio.slice(s, e); // 転送用にコピー
      worker.postMessage({ type: 'run', id: idx, audio: slice, offsetSec: s / SAMPLE_RATE } satisfies WorkerIn, [slice.buffer]);
    };
    worker.onerror = (e) => fail('端末内の文字起こしエンジンでエラーが発生しました。ブラウザを更新して再試行してください。', e);
    worker.onmessage = ({ data }) => {
      switch (data.type) {
        case 'download':
          input.onProgress({ label: `モデルをダウンロード中（初回のみ）`, ratio: data.ratio });
          break;
        case 'ready':
          next();
          break;
        case 'result':
          out.push(...data.chunks);
          idx++;
          next();
          break;
        case 'error':
          fail(
            /fetch|network|Failed to|load/i.test(data.message)
              ? 'モデルのダウンロードまたは読み込みに失敗しました。通信状況を確認して再試行してください（初回のみ約100MBの通信が必要です）。'
              : '端末内の文字起こしに失敗しました。メモリ不足の可能性があります。小さいモデル（tiny）に変更するか、Geminiをお試しください。',
            new Error(data.message),
          );
          break;
      }
    };
    input.onProgress({ label: 'モデルを準備中' });
    worker.postMessage({ type: 'init', modelId, gpu: deps.useGpu, wasmBase: deps.basePath });
  });
}

/** 設定画面から事前にモデルをダウンロードする（Wi-Fi接続中に済ませておくため）。 */
export function prefetchWhisper(size: WhisperSize, onProgress: (ratio: number) => void, deps: LocalDeps = defaultLocalDeps()): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = deps.createWorker();
    const done = (err?: EngineError) => {
      worker.terminate();
      if (err) reject(err);
      else resolve();
    };
    worker.onerror = (e) => done(new EngineError('エンジンの準備中にエラーが発生しました。', { cause: e }));
    worker.onmessage = ({ data }) => {
      if (data.type === 'download') onProgress(data.ratio);
      else if (data.type === 'ready') done();
      else if (data.type === 'error') done(new EngineError('モデルのダウンロードに失敗しました。通信状況を確認して再試行してください。', { cause: new Error(data.message) }));
    };
    worker.postMessage({ type: 'init', modelId: WHISPER_MODELS[size].id, gpu: false, wasmBase: deps.basePath });
  });
}
