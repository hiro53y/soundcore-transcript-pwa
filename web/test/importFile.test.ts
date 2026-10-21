import { describe, expect, it } from 'vitest';
import { getAudio, listRecords } from '../src/lib/db';
import { HARD_MAX_BYTES, fingerprintOf, importAudio, titleFromFileName, validateClientSide } from '../src/lib/importFile';
import { fakeMp3, mp3File } from './helpers';

describe('通常のMP3取り込み', () => {
  it('MP3を取り込み、記録と音声をIndexedDBへ保存する', async () => {
    const f = mp3File('2026-10-01 定例会議.mp3');
    const r = await importAudio(f, { name: f.name, mime: f.type, source: 'picker' });
    expect(r.kind).toBe('created');
    if (r.kind !== 'created') return;
    expect(r.record.title).toBe('2026-10-01 定例会議');
    expect(r.record.fileSize).toBe(4096);
    expect(r.record.stages.transcribe.status).toBe('idle'); // 自動でAPI送信しない
    expect(r.record.source).toBe('picker');
    expect((await getAudio(r.record.id))?.blob.size).toBe(4096);
    expect(await listRecords()).toHaveLength(1);
  });

  it.each([
    ['audio/mpeg', 'a.mp3'],
    ['audio/mp3', 'a.mp3'],
    ['audio/x-mpeg', 'a.mp3'],
    ['audio/*', 'a.mp3'],
    ['', 'a.mp3'],
    ['application/octet-stream', 'a.MP3'],
  ])('MIME違い (%s, %s) でも受け入れる', async (mime, name) => {
    const f = new File([fakeMp3(2048, mime.length + name.length)], name, { type: mime });
    const r = await importAudio(f, { name, mime, source: 'share' });
    expect(r.kind).toBe('created');
  });
});

describe('不正ファイル', () => {
  it('0 byte', async () => {
    const r = await importAudio(new File([], 'a.mp3', { type: 'audio/mpeg' }), { name: 'a.mp3', mime: 'audio/mpeg', source: 'picker' });
    expect(r).toMatchObject({ kind: 'invalid', reason: 'empty' });
  });
  it('MP3拡張子でも中身が音声でない', async () => {
    const f = new File(['hello, this is text'], 'fake.mp3', { type: 'audio/mpeg' });
    const r = await importAudio(f, { name: f.name, mime: f.type, source: 'picker' });
    expect(r).toMatchObject({ kind: 'invalid', reason: 'not_audio' });
    expect(await listRecords()).toHaveLength(0);
  });
  it('画像・PDF等のMIMEは拒否', async () => {
    const f = new File([fakeMp3()], 'x.pdf', { type: 'application/pdf' });
    expect(await validateClientSide(f, f.name, f.type)).toBe('not_audio');
  });
  it('巨大ファイルは拒否（実体を作らず size だけ偽装）', async () => {
    const big = { size: HARD_MAX_BYTES + 1, slice: () => new Blob([fakeMp3()]) } as unknown as Blob;
    expect(await validateClientSide(big, 'a.mp3', 'audio/mpeg')).toBe('too_large');
  });
});

describe('重複登録の防止', () => {
  it('同じ音声を2回取り込んでも記録は1件', async () => {
    const a = mp3File('a.mp3', 'audio/mpeg', 8192, 5);
    const b = mp3File('renamed.mp3', 'audio/mpeg', 8192, 5); // 名前が違っても内容が同じ
    const r1 = await importAudio(a, { name: a.name, mime: a.type, source: 'share' });
    const r2 = await importAudio(b, { name: b.name, mime: b.type, source: 'share' });
    expect(r1.kind).toBe('created');
    expect(r2.kind).toBe('duplicate');
    if (r1.kind === 'created' && r2.kind === 'duplicate') expect(r2.record.id).toBe(r1.record.id);
    expect(await listRecords()).toHaveLength(1);
  });
  it('内容が違えば別記録', async () => {
    await importAudio(mp3File('a.mp3', 'audio/mpeg', 8192, 1), { name: 'a.mp3', mime: 'audio/mpeg', source: 'picker' });
    const r = await importAudio(mp3File('b.mp3', 'audio/mpeg', 8192, 2), { name: 'b.mp3', mime: 'audio/mpeg', source: 'picker' });
    expect(r.kind).toBe('created');
  });
  it('指紋は決定的で、サイズ・内容が違えば変わる', async () => {
    expect(await fingerprintOf(mp3File('a', 'audio/mpeg', 5000, 1))).toBe(await fingerprintOf(mp3File('b', 'audio/mpeg', 5000, 1)));
    expect(await fingerprintOf(mp3File('a', 'audio/mpeg', 5000, 1))).not.toBe(await fingerprintOf(mp3File('a', 'audio/mpeg', 5001, 1)));
  });
});

describe('titleFromFileName', () => {
  it('拡張子を除き、空なら既定名', () => {
    expect(titleFromFileName('会議_メモ.mp3')).toBe('会議 メモ');
    expect(titleFromFileName('.mp3')).toBe('無題の録音');
  });
});
