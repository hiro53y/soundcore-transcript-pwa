import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { promisify } from 'node:util';
import { AppError } from '../errors.js';

const execFileAsync = promisify(execFile);

import { sniffAudio, type SniffedKind } from '@app/shared';

export { sniffAudio, type SniffedKind };

export async function readHead(file: string, n = 32): Promise<Uint8Array> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/** ffprobeで実際にデコード可能か確認し、長さ(秒)を返す。 */
export async function probeDuration(file: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'format=duration', '-of', 'json', file],
      { timeout: 60_000 },
    );
    const d = Number(JSON.parse(stdout)?.format?.duration);
    if (!Number.isFinite(d) || d <= 0) throw new Error('no duration');
    return d;
  } catch (cause) {
    throw new AppError('file_corrupt', undefined, { cause });
  }
}

export interface ValidateOptions {
  size: number;
  maxBytes: number;
  maxDurationSec: number;
}

export async function validateAudioFile(file: string, opt: ValidateOptions): Promise<{ durationSec: number; kind: SniffedKind }> {
  if (opt.size === 0) throw new AppError('file_empty');
  if (opt.size > opt.maxBytes) {
    throw new AppError('file_too_large', `ファイルが大きすぎます（上限 ${Math.floor(opt.maxBytes / 1024 / 1024)}MB）。`);
  }
  const kind = sniffAudio(await readHead(file));
  if (!kind) throw new AppError('file_not_audio');
  const durationSec = await probeDuration(file);
  if (durationSec > opt.maxDurationSec) {
    throw new AppError('duration_too_long', `音声が長すぎます（上限 ${Math.floor(opt.maxDurationSec / 60)}分）。`);
  }
  return { durationSec, kind };
}
