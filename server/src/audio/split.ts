import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AppError } from '../errors.js';

const execFileAsync = promisify(execFile);

export interface Silence {
  start: number;
  end: number;
}

export interface ChunkPlan {
  index: number;
  /** 切り出し開始（強制分割時は前チャンクとオーバーラップする）。 */
  startSec: number;
  endSec: number;
  /** 先頭側が前チャンクと重複しているか（境界の重複除去対象）。 */
  overlapsPrevious: boolean;
}

/** ffmpeg silencedetect の stderr から無音区間を抽出する。 */
export function parseSilences(stderr: string, durationSec: number): Silence[] {
  const out: Silence[] = [];
  let start: number | null = null;
  for (const line of stderr.split('\n')) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    const e = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (e && start !== null) {
      out.push({ start, end: Number(e[1]) });
      start = null;
    }
  }
  if (start !== null) out.push({ start, end: durationSec });
  return out;
}

/**
 * 目標長付近の無音点で分割する計画を立てる（純関数）。
 * 文の途中で機械的に切るのを避けるため、目標±窓内の無音中央を優先。見つからなければ強制分割＋オーバーラップ。
 */
export function planChunks(
  durationSec: number,
  silences: Silence[],
  opt: { targetSec: number; overlapSec: number },
): ChunkPlan[] {
  const { targetSec, overlapSec } = opt;
  if (durationSec <= targetSec * 1.3) {
    return [{ index: 0, startSec: 0, endSec: durationSec, overlapsPrevious: false }];
  }
  const mids = silences.map((s) => (s.start + s.end) / 2).sort((a, b) => a - b);
  const plans: ChunkPlan[] = [];
  let cursor = 0; // 次チャンクの論理的な開始点
  let prevForced = false;
  while (durationSec - cursor > targetSec * 1.3) {
    const goal = cursor + targetSec;
    const lo = cursor + targetSec * 0.6;
    const hi = cursor + targetSec * 1.25;
    let best: number | null = null;
    for (const m of mids) {
      if (m < lo || m > hi) continue;
      if (best === null || Math.abs(m - goal) < Math.abs(best - goal)) best = m;
    }
    const forced = best === null;
    const cut = best ?? goal;
    plans.push({
      index: plans.length,
      startSec: prevForced ? Math.max(0, cursor - overlapSec) : cursor,
      endSec: cut,
      overlapsPrevious: prevForced,
    });
    cursor = cut;
    prevForced = forced;
  }
  plans.push({
    index: plans.length,
    startSec: prevForced ? Math.max(0, cursor - overlapSec) : cursor,
    endSec: durationSec,
    overlapsPrevious: prevForced,
  });
  return plans;
}

async function ffmpeg(args: string[], timeout = 30 * 60_000): Promise<string> {
  try {
    const { stderr } = await execFileAsync('ffmpeg', ['-hide_banner', '-nostdin', '-y', ...args], {
      timeout,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stderr;
  } catch (cause) {
    throw new AppError('file_corrupt', undefined, { cause });
  }
}

/** 音声認識向けに モノラル/16kHz/32kbps MP3 へ圧縮する（1時間≒14MB）。 */
export async function normalizeAudio(input: string, output: string): Promise<void> {
  await ffmpeg(['-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', output]);
}

export async function detectSilences(file: string, durationSec: number): Promise<Silence[]> {
  const stderr = await ffmpeg(['-i', file, '-af', 'silencedetect=noise=-35dB:d=0.6', '-f', 'null', '-']);
  return parseSilences(stderr, durationSec);
}

export async function cutChunk(input: string, plan: ChunkPlan, output: string): Promise<void> {
  await ffmpeg([
    '-ss', plan.startSec.toFixed(3),
    '-t', (plan.endSec - plan.startSec).toFixed(3),
    '-i', input,
    '-c', 'copy',
    output,
  ]);
}
