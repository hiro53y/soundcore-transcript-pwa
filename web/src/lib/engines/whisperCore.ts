import { formatClock } from '@app/shared';
import type { WhisperSize } from '../types';

/** 端末内Whisper（ONNX, 量子化）。モデルは Hugging Face Hub から初回のみ取得し、ブラウザのCache Storageに保存される。 */
export const WHISPER_MODELS: Record<WhisperSize, { id: string; label: string; approxMb: number; note: string }> = {
  tiny: { id: 'onnx-community/whisper-tiny', label: 'tiny（最速・精度低）', approxMb: 41, note: '短い録音・動作確認向け' },
  base: { id: 'onnx-community/whisper-base', label: 'base（標準）', approxMb: 77, note: '速度と精度のバランス' },
  small: { id: 'onnx-community/whisper-small', label: 'small（高精度・遅い）', approxMb: 249, note: '精度重視。端末が遅いと非常に時間がかかります' },
};
/** onnxruntime の wasm 本体（初回のみ。以降はキャッシュ） */
export const ORT_WASM_MB = 27;

/** 端末内処理の上限（デコード後の音声がメモリを圧迫するため）。 */
export const LOCAL_MAX_SEC = 45 * 60;
export const SAMPLE_RATE = 16000;
export const SEGMENT_SEC = 150;

export interface RawChunk {
  start: number;
  end: number;
  text: string;
}

/** 目標位置の前後 radius 秒で、最も静かな点（100msフレームのRMS最小）を探して切り分け位置にする。 */
export function findQuietCut(samples: Float32Array, targetSec: number, radiusSec = 6, sampleRate = SAMPLE_RATE): number {
  const frame = Math.floor(sampleRate / 10);
  const lo = Math.max(0, Math.floor((targetSec - radiusSec) * sampleRate));
  const hi = Math.min(samples.length - frame, Math.floor((targetSec + radiusSec) * sampleRate));
  if (hi <= lo) return Math.min(samples.length, Math.floor(targetSec * sampleRate));
  let best = lo;
  let bestE = Infinity;
  for (let i = lo; i <= hi; i += frame) {
    let e = 0;
    for (let j = i; j < i + frame; j++) e += samples[j]! * samples[j]!;
    if (e < bestE) {
      bestE = e;
      best = i;
    }
  }
  return best + (frame >> 1);
}

/** 区間分割（できるだけ静かな位置で切る）。戻り値は [開始サンプル, 終了サンプル) の配列。 */
export function planSegments(samples: Float32Array, segmentSec = SEGMENT_SEC, sampleRate = SAMPLE_RATE): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  while (samples.length - start > segmentSec * 1.4 * sampleRate) {
    const cut = findQuietCut(samples, start / sampleRate + segmentSec, 6, sampleRate);
    out.push([start, cut]);
    start = cut;
  }
  out.push([start, samples.length]);
  return out;
}

/** ほぼ無音の区間か（Whisperは無音で幻覚を出すため、無音区間はモデルに渡さない）。 */
export function isSilent(samples: Float32Array, threshold = 0.003): boolean {
  if (samples.length === 0) return true;
  let e = 0;
  const step = Math.max(1, Math.floor(samples.length / 20000));
  let n = 0;
  for (let i = 0; i < samples.length; i += step) {
    e += samples[i]! * samples[i]!;
    n++;
  }
  return Math.sqrt(e / n) < threshold;
}

/** 同じ文が3回以上連続するループ（Whisperの典型的な誤動作）を1回にまとめる。 */
export function cleanChunks(chunks: RawChunk[]): RawChunk[] {
  const out: RawChunk[] = [];
  let run = 0;
  for (const c of chunks) {
    const text = c.text.trim();
    if (!text) continue;
    const prev = out[out.length - 1];
    if (prev && prev.text === text) {
      run++;
      if (run >= 2) {
        prev.end = c.end;
        continue; // 3回目以降は捨てる
      }
    } else run = 0;
    out.push({ ...c, text });
  }
  return out;
}

/** 約 groupSec 秒ごとに `[hh:mm:ss]` 見出しを付けた文字起こしに整形する（v1/Gemini と同じ形式）。 */
export function formatChunks(chunks: RawChunk[], groupSec = 60): string {
  const blocks: { start: number; texts: string[] }[] = [];
  for (const c of chunks) {
    const last = blocks[blocks.length - 1];
    if (!last || c.start - last.start >= groupSec) blocks.push({ start: c.start, texts: [c.text] });
    else last.texts.push(c.text);
  }
  return blocks.map((b) => `[${formatClock(b.start)}]\n${b.texts.join('')}`).join('\n\n');
}

export type WorkerIn =
  | { type: 'init'; modelId: string; gpu: boolean; wasmBase: string }
  | { type: 'run'; id: number; audio: Float32Array; offsetSec: number; language?: string };

export type WorkerOut =
  | { type: 'download'; ratio: number }
  | { type: 'ready'; device: 'webgpu' | 'wasm' }
  | { type: 'result'; id: number; chunks: RawChunk[] }
  | { type: 'error'; message: string };

export interface WorkerLike {
  postMessage(msg: WorkerIn, transfer?: Transferable[]): void;
  onmessage: ((e: { data: WorkerOut }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
  terminate(): void;
}
