import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../src/config.js';

/** ffmpegでテスト用MP3を生成（著作権・個人情報を含まない合成音）。 */
export function makeMp3(opts: { seconds: number; silenceAtSec?: number[] }): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'testaudio-'));
  const out = path.join(dir, 'tone.mp3');
  // 440Hz サイン波。silenceAtSec の位置に1秒の無音を挿入する
  let expr = 'sin(440*2*PI*t)';
  for (const s of opts.silenceAtSec ?? []) expr = `${expr}*not(between(t,${s},${s + 1}))`;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=exprs='${expr}*0.3':s=16000:d=${opts.seconds}`, '-b:a', '32k', out]);
  return out;
}

export function testConfig(over: Partial<Config> = {}): Config {
  const tmpRoot = path.join(mkdtempSync(path.join(os.tmpdir(), 'pwa-test-')), 'jobs');
  return loadConfig(
    { PROVIDER: 'mock', APP_ACCESS_TOKEN: 'test-token-123456', OPENAI_API_KEY: 'sk-test' },
    { tmpRoot, retryBaseDelayMs: 1, chunkTargetSec: 10, webDist: '/nonexistent', ...over },
  );
}

export function multipartBody(file: Buffer, filename = 'a.mp3', fields: Record<string, string> = {}): { body: Buffer; headers: Record<string, string> } {
  const b = '----testboundary' + Math.random().toString(16).slice(2);
  const chunks: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  chunks.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="audio"; filename="${filename}"\r\nContent-Type: audio/mpeg\r\n\r\n`));
  chunks.push(file, Buffer.from(`\r\n--${b}--\r\n`));
  return { body: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}
