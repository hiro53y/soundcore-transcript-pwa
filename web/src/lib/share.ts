import { isAcceptedAudioType } from '@app/shared';
import type { AppDB } from './db';
import type { ShareInboxRow } from './types';

/** 共有受信箱の保持期限。これより古い未消費データは起動時に削除する。 */
export const INBOX_TTL_MS = 24 * 60 * 60 * 1000;

export interface ShareDeps {
  putInbox(row: ShareInboxRow): Promise<void>;
  now(): number;
  newId(): string;
}

/**
 * Service Worker が POST /share-target を受けたときの処理（純関数に近い形で切り出し、テスト可能にしている）。
 * 受け取ったファイルをIndexedDBへ一時保存し、通常画面へ 303 リダイレクトする。
 * - 303 にすることで、ページ更新が「POSTの再送」にならない。
 * - 保存先IDはランダム。ページ側が取り出し時に削除する（二重登録・再処理防止）。
 */
export async function handleShare(request: Request, deps: ShareDeps): Promise<Response> {
  // 配信パス(base)は共有POSTのURLから導く（例: /soundcore-transcript-pwa/share-target → /soundcore-transcript-pwa/）
  const path = new URL(request.url).pathname;
  const base = path.endsWith('share-target') ? path.slice(0, -'share-target'.length) : '/';
  const redirect = (qs: string) => new Response(null, { status: 303, headers: { Location: `${base}?${qs}` } });
  try {
    const form = await request.formData();
    const ids: string[] = [];
    const title = typeof form.get('title') === 'string' ? (form.get('title') as string) : undefined;
    const text = typeof form.get('text') === 'string' ? (form.get('text') as string) : undefined;
    for (const [, value] of form.entries()) {
      if (typeof value === 'string') continue;
      const file = value as File;
      const id = deps.newId();
      await deps.putInbox({
        id,
        file,
        fileName: file.name || 'shared-audio',
        mime: file.type,
        size: file.size,
        receivedAt: deps.now(),
        title,
        text,
      });
      ids.push(id);
    }
    if (ids.length === 0) return redirect('share_error=nofile');
    return redirect(ids.map((i) => `share=${encodeURIComponent(i)}`).join('&'));
  } catch {
    return redirect('share_error=failed');
  }
}

export async function purgeExpiredInbox(db: AppDB, now: number): Promise<number> {
  const tx = db.transaction('shareInbox', 'readwrite');
  const old = await tx.store.index('byReceived').getAllKeys(IDBKeyRange.upperBound(now - INBOX_TTL_MS));
  for (const k of old) await tx.store.delete(k);
  await tx.done;
  return old.length;
}

export { isAcceptedAudioType };
