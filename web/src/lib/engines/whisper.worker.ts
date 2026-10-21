/// <reference lib="webworker" />
import { env, pipeline } from '@huggingface/transformers';
import type { RawChunk, WorkerIn, WorkerOut } from './whisperCore';

// 端末内Whisper の実行本体（Web Worker）。メイン画面をブロックしない。
const post = (m: WorkerOut) => (self as unknown as Worker).postMessage(m);

type Transcriber = (audio: Float32Array, opts: Record<string, unknown>) => Promise<{ text: string; chunks?: { timestamp: [number, number | null]; text: string }[] }>;
let transcriber: Transcriber | undefined;

async function init(msg: Extract<WorkerIn, { type: 'init' }>) {
  env.allowLocalModels = false;
  // onnxruntime の wasm は CDN ではなく自サイト（/ort/）から取得する
  const wasm = (env.backends.onnx as { wasm?: { wasmPaths?: unknown } }).wasm;
  if (wasm) {
    wasm.wasmPaths = {
      mjs: `${msg.wasmBase}ort/ort-wasm-simd-threaded.asyncify.mjs`,
      wasm: `${msg.wasmBase}ort/ort-wasm-simd-threaded.asyncify.wasm`,
    };
  }
  const files = new Map<string, { loaded: number; total: number }>();
  let maxRatio = 0;
  const progress_callback = (e: { status?: string; file?: string; loaded?: number; total?: number }) => {
    if (e.status !== 'progress' || !e.file) return;
    files.set(e.file, { loaded: e.loaded ?? 0, total: e.total ?? 0 });
    let l = 0;
    let t = 0;
    for (const f of files.values()) {
      l += f.loaded;
      t += f.total;
    }
    if (t > 0) {
      maxRatio = Math.max(maxRatio, l / t);
      post({ type: 'download', ratio: maxRatio });
    }
  };
  const make = (gpu: boolean) =>
    pipeline('automatic-speech-recognition', msg.modelId, {
      device: gpu ? 'webgpu' : 'wasm',
      dtype: gpu ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : 'q8',
      progress_callback,
    } as never) as unknown as Promise<Transcriber>;
  let device: 'webgpu' | 'wasm' = 'wasm';
  if (msg.gpu && 'gpu' in navigator) {
    try {
      transcriber = await make(true);
      device = 'webgpu';
    } catch {
      transcriber = undefined; // WebGPUで失敗したらWASMへフォールバック
    }
  }
  if (!transcriber) transcriber = await make(false);
  post({ type: 'ready', device });
}

async function run(msg: Extract<WorkerIn, { type: 'run' }>) {
  if (!transcriber) throw new Error('model not loaded');
  const r = await transcriber(msg.audio, {
    language: msg.language ?? 'japanese',
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
  });
  const chunks: RawChunk[] = (r.chunks ?? [{ timestamp: [0, null], text: r.text }]).map((c) => ({
    start: msg.offsetSec + (c.timestamp[0] ?? 0),
    end: msg.offsetSec + (c.timestamp[1] ?? c.timestamp[0] ?? 0),
    text: c.text,
  }));
  post({ type: 'result', id: msg.id, chunks });
}

self.onmessage = (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  const job = m.type === 'init' ? init(m) : run(m);
  job.catch((err: unknown) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }));
};
