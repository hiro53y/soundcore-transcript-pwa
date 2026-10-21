import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * 配信パス。サーバー配信は '/'、GitHub Pages(プロジェクトサイト)は '/<リポジトリ名>/'。
 * manifest の start_url / scope / share_target.action、SW、アセットがすべてこの値に連動する。
 */
const rawBase = process.env.VITE_BASE ?? '/';
export const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;

/** onnxruntime の wasm を CDN ではなく自サイト(<base>ort/)から配信する（端末内Whisper用）。 */
const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];
function ortAssets(): Plugin {
  const dir = [path.resolve(__dirname, '../node_modules/onnxruntime-web/dist'), path.resolve(__dirname, 'node_modules/onnxruntime-web/dist')].find((d) =>
    existsSync(path.join(d, ORT_FILES[0]!)),
  );
  if (!dir) throw new Error('onnxruntime-web が見つかりません。npm ci を実行してください。');
  return {
    name: 'ort-assets',
    configureServer(server) {
      server.middlewares.use(`${base}ort/`, (req, res, next) => {
        const name = (req.url ?? '').replace(/^\//, '').split('?')[0] ?? '';
        if (!ORT_FILES.includes(name)) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(readFileSync(path.join(dir, name)));
      });
    },
    generateBundle: {
      order: 'post',
      handler(_opts, bundle) {
        // onnxruntime-web が自動でバンドルする重複のwasm(約27MB)は使わない（wasmPathsで <base>ort/ を指定するため）
        for (const name of Object.keys(bundle)) if (/^assets\/ort-wasm.*\.wasm$/.test(name)) delete bundle[name];
        for (const f of ORT_FILES) this.emitFile({ type: 'asset', fileName: `ort/${f}`, source: readFileSync(path.join(dir, f)) });
      },
    },
  };
}

export const manifest = {
  id: base,
  name: 'AI文字起こし・議事録',
  short_name: '議事録AI',
  description: 'MP3を共有するだけで、文字起こし・誤認識の確認・整文・議事録作成まで行えます。',
  lang: 'ja',
  start_url: base,
  scope: base,
  display: 'standalone',
  background_color: '#0f172a',
  theme_color: '#1d4ed8',
  icons: [
    { src: `${base}icons/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: `${base}icons/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: `${base}icons/maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
  // Android の共有シートに本アプリを表示するための設定。
  // 共有元アプリごとにMIMEが異なりうるため audio/* と拡張子、octet-stream を許容する（受信後に中身を検証）。
  share_target: {
    action: `${base}share-target`,
    method: 'POST',
    enctype: 'multipart/form-data',
    params: {
      title: 'title',
      text: 'text',
      files: [
        {
          name: 'audio',
          accept: ['audio/mpeg', 'audio/mp3', 'audio/x-mpeg', 'audio/mpeg3', 'audio/x-mp3', 'audio/*', '.mp3', '.m4a', '.wav', 'application/octet-stream'],
        },
      ],
    },
  },
} as const;

export default defineConfig({
  base,
  worker: { format: 'es' },
  plugins: [
    react(),
    ortAssets(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      manifest: manifest as never,
      manifestFilename: 'manifest.webmanifest',
      injectManifest: { globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'] },
      devOptions: { enabled: false },
    }),
  ],
  define: { __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.1.0') },
  server: { proxy: { '/api': 'http://localhost:8080' } },
  build: { sourcemap: false },
  test: {
    environment: 'node',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    testTimeout: 20000,
  },
});
