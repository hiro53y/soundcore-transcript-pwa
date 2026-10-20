import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export const manifest = {
  id: '/',
  name: 'AI文字起こし・議事録',
  short_name: '議事録AI',
  description: 'MP3を共有するだけで、文字起こし・誤認識の確認・整文・議事録作成まで行えます。',
  lang: 'ja',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0f172a',
  theme_color: '#1d4ed8',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
  // Android の共有シートに本アプリを表示するための設定。
  // 共有元アプリごとにMIMEが異なりうるため audio/* と拡張子、octet-stream を許容する（受信後に中身を検証）。
  share_target: {
    action: '/share-target',
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
  plugins: [
    react(),
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
