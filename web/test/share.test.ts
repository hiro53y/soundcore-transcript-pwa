import { describe, expect, it } from 'vitest';
import { getDB, listRecords, openAppDB } from '../src/lib/db';
import { consumeShares } from '../src/lib/importFile';
import { INBOX_TTL_MS, handleShare, purgeExpiredInbox, type ShareDeps } from '../src/lib/share';
import type { ShareInboxRow } from '../src/lib/types';
import { fakeMp3, mp3File } from './helpers';

async function deps(now = () => Date.now()): Promise<ShareDeps> {
  const db = await getDB();
  let n = 0;
  return { putInbox: async (row) => void (await db.put('shareInbox', row)), now, newId: () => `id${++n}` };
}

function shareRequest(entries: [string, string | File][]): Request {
  const form = new FormData();
  for (const [k, v] of entries) form.append(k, v);
  return new Request('https://app.example/share-target', { method: 'POST', body: form });
}

describe('Share Target 受信（Service Workerの処理）', () => {
  it('共有されたMP3をIndexedDBへ一時保存し、303で通常画面へ', async () => {
    const res = await handleShare(shareRequest([['audio', mp3File('Soundcore_export.mp3', 'audio/mpeg', 3000)], ['title', '録音']]), await deps(() => 1234));
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/?share=id1');
    const row = await (await getDB()).get('shareInbox', 'id1');
    expect(row).toMatchObject({ fileName: 'Soundcore_export.mp3', mime: 'audio/mpeg', size: 3000, receivedAt: 1234, title: '録音' });
  });

  it('MIMEが空/octet-streamでも保存する（検証はページ側で内容から行う）', async () => {
    const res = await handleShare(shareRequest([['audio', new File([fakeMp3()], 'x.mp3', { type: 'application/octet-stream' })]]), await deps());
    expect(res.headers.get('Location')).toBe('/?share=id1');
    expect((await (await getDB()).get('shareInbox', 'id1'))?.mime).toBe('application/octet-stream');
  });

  it('ファイルが無い共有(テキストのみ)は share_error=nofile', async () => {
    const res = await handleShare(shareRequest([['text', 'こんにちは']]), await deps());
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/?share_error=nofile');
  });

  it('保存に失敗したら share_error=failed（例外を投げない）', async () => {
    const res = await handleShare(shareRequest([['audio', mp3File()]]), { putInbox: async () => { throw new Error('quota'); }, now: () => 1, newId: () => 'x' });
    expect(res.headers.get('Location')).toBe('/?share_error=failed');
  });

  it('不正なリクエスト本文でも failed へ', async () => {
    const res = await handleShare(new Request('https://app.example/share-target', { method: 'POST', body: 'not form' }), await deps());
    expect(res.headers.get('Location')).toBe('/?share_error=failed');
  });
});

describe('共有の取り込み（ページ側）', () => {
  async function seed(id: string, file: File, receivedAt = Date.now()) {
    const row: ShareInboxRow = { id, file, fileName: file.name, mime: file.type, size: file.size, receivedAt };
    await (await getDB()).put('shareInbox', row);
  }

  it('受信箱から取り出して記録化し、受信箱は空になる', async () => {
    await seed('s1', mp3File('a.mp3'));
    const [o] = await consumeShares(['s1']);
    expect(o?.result.kind).toBe('created');
    expect(o?.meta).toMatchObject({ name: 'a.mp3', mime: 'audio/mpeg' });
    expect(await (await getDB()).count('shareInbox')).toBe(0);
    expect((await listRecords())[0]?.source).toBe('share');
  });

  it('ページ更新（同じIDで再実行）しても再処理・二重登録されない', async () => {
    await seed('s1', mp3File('a.mp3'));
    await consumeShares(['s1']);
    const [again] = await consumeShares(['s1']);
    expect(again?.result.kind).toBe('missing');
    expect(await listRecords()).toHaveLength(1);
  });

  it('同じ音声を別の共有で送っても重複登録しない', async () => {
    await seed('s1', mp3File('a.mp3'));
    await seed('s2', mp3File('b.mp3'));
    const outcomes = await consumeShares(['s1', 's2']);
    expect(outcomes.map((o) => o.result.kind)).toEqual(['created', 'duplicate']);
    expect(await listRecords()).toHaveLength(1);
    expect(await (await getDB()).count('shareInbox')).toBe(0);
  });

  it('音声でない共有は拒否し、受信箱からも削除する', async () => {
    await seed('s1', new File(['text'], 'note.mp3', { type: 'audio/mpeg' }));
    const [o] = await consumeShares(['s1']);
    expect(o?.result).toMatchObject({ kind: 'invalid', reason: 'not_audio' });
    expect(await (await getDB()).count('shareInbox')).toBe(0);
  });
});

describe('一時データのクリーンアップ', () => {
  it('24時間を超えた未消費の受信データだけ削除する', async () => {
    const db = await openAppDB();
    const now = 10 * INBOX_TTL_MS;
    const mk = (id: string, receivedAt: number): ShareInboxRow => ({ id, file: new Blob(['x']), fileName: id, mime: '', size: 1, receivedAt });
    await db.put('shareInbox', mk('old', now - INBOX_TTL_MS - 1));
    await db.put('shareInbox', mk('fresh', now - 1000));
    expect(await purgeExpiredInbox(db, now)).toBe(1);
    expect((await db.getAllKeys('shareInbox')).sort()).toEqual(['fresh']);
  });
});
