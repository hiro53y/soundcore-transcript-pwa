/// <reference lib="webworker" />
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { openAppDB } from './lib/db';
import { handleShare, purgeExpiredInbox } from './lib/share';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

// ---- Web Share Target: POST /share-target を受け取り、IndexedDB に一時保存して 303 で通常画面へ ----
// ※ workbox のルーティングより前に登録すること。POST は workbox の GET ルートとは競合しない。
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(
      (async () => {
        const db = await openAppDB();
        return handleShare(event.request, {
          putInbox: async (row) => {
            await db.put('shareInbox', row);
          },
          now: () => Date.now(),
          newId: () => crypto.randomUUID(),
        });
      })().catch(() => new Response(null, { status: 303, headers: { Location: '/?share_error=failed' } })),
    );
  }
});

// ---- アプリシェルのプリキャッシュ（revision付き。旧版は自動削除） ----
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPAのナビゲーションはキャッシュ済み index.html を返す（オフライン時の基本画面）。API・共有は対象外。
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { denylist: [/^\/api\//, /^\/share-target/] }));

// 新しいSWは待機し、ユーザーが「更新」を押したときだけ有効化する（処理中の強制リロード防止）。
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      try {
        await purgeExpiredInbox(await openAppDB(), Date.now()); // 24時間超の未消費の共有データを掃除
      } catch {
        /* 掃除失敗は致命的ではない */
      }
    })(),
  );
});
