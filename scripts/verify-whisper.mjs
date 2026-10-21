// 手動検証用（要ネットワーク）: ビルド済みの端末内Whisperワーカーを実ブラウザで実行し、実際に文字起こしできるか確認する。
// 使い方: npm run build && node scripts/verify-whisper.mjs <音声ファイル> [tiny|base|small] [言語(既定 english)]
// 初回は Hugging Face Hub からモデルを取得する。実際の会議音声は使わないこと。
import { createServer } from 'node:http';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const [file, size = 'tiny', language = 'english'] = process.argv.slice(2);
if (!file || !existsSync(file)) {
  console.error('音声ファイルを指定してください');
  process.exit(2);
}
const dist = path.resolve('web/dist');
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.html': 'text/html', '.css': 'text/css' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__audio') return res.end(readFileSync(file));
  const p = path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!p.startsWith(dist) || !existsSync(p)) return res.writeHead(404).end();
  res.setHeader('Content-Type', MIME[path.extname(p)] ?? 'application/octet-stream');
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(18090, r));
const workerFile = readdirSync(path.join(dist, 'assets')).find((f) => f.startsWith('whisper.worker'));
const chromePath = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find(existsSync);
const browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
const page = await browser.newPage();
page.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.log('[browser]', m.text().slice(0, 200)));
await page.goto('http://localhost:18090/');
const t0 = Date.now();
const out = await page.evaluate(
  async ({ workerFile, size, language }) => {
    const bytes = await (await fetch('/__audio')).arrayBuffer();
    const ctx = new AudioContext({ sampleRate: 16000 });
    const buf = await ctx.decodeAudioData(bytes);
    const audio = buf.getChannelData(0).slice();
    const worker = new Worker(`/assets/${workerFile}`, { type: 'module' });
    return await new Promise((resolve) => {
      let dl = 0;
      let tReady = 0;
      worker.onerror = (e) => resolve({ error: e.message });
      worker.onmessage = ({ data }) => {
        if (data.type === 'download') dl = Math.max(dl, data.ratio);
        if (data.type === 'ready') tReady = performance.now();
        if (data.type === 'ready') worker.postMessage({ type: 'run', id: 0, audio, offsetSec: 0, language }, [audio.buffer]);
        if (data.type === 'result') resolve({ chunks: data.chunks, seconds: buf.duration, dl, inferenceSec: (performance.now() - tReady) / 1000 });
        if (data.type === 'error') resolve({ error: data.message });
      };
      worker.postMessage({ type: 'init', modelId: `onnx-community/whisper-${size}`, gpu: false, wasmBase: '/' });
    });
  },
  { workerFile, size, language },
);
console.log(JSON.stringify(out, null, 1).slice(0, 1500));
console.log(`elapsed ${(Date.now() - t0) / 1000}s`);
await browser.close();
server.close();
process.exit(out.error ? 1 : 0);
