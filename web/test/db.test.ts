import { describe, expect, it } from 'vitest';
import { buildBackup, importBackup, parseBackup, BackupError } from '../src/lib/backup';
import { deleteAudio, deleteDictionaryEntry, deleteRecord, getAudio, getRecord, getSettings, listDictionary, listRecords, patchSettings, putAudio, putDictionaryEntry, putRecord, resetDBForTest } from '../src/lib/db';
import { newRecord } from '../src/lib/importFile';

const mk = (id: string, at = '2026-10-01T00:00:00Z') => newRecord({ id, fileName: `${id}.mp3`, fileSize: 10, fingerprint: `fp-${id}`, source: 'picker', now: at });

describe('履歴の保存', () => {
  it('生・確認済み・整文・議事録・要約を1つの記録に関連付けて保持し、新しい順に並ぶ', async () => {
    const a = mk('a', '2026-10-01T00:00:00Z');
    a.rawTranscript = 'RAW';
    a.confirmedTranscript = 'CONF';
    a.polished = { text: 'POL', model: 'm', createdAt: 'x' };
    a.outputs.minutes = { text: 'MIN', model: 'm', createdAt: 'x' };
    a.outputs.summary = { text: 'SUM', model: 'm', createdAt: 'x' };
    await putRecord(a);
    await putRecord(mk('b', '2026-10-02T00:00:00Z'));
    const list = await listRecords();
    expect(list.map((r) => r.id)).toEqual(['b', 'a']);
    const got = await getRecord('a');
    expect([got?.rawTranscript, got?.confirmedTranscript, got?.polished?.text, got?.outputs.minutes?.text, got?.outputs.summary?.text]).toEqual(['RAW', 'CONF', 'POL', 'MIN', 'SUM']);
  });

  it('生文字起こしは一度保存したら上書きできない（整文等は更新できる）', async () => {
    const r = mk('a');
    r.rawTranscript = 'RAW';
    await putRecord(r);
    await expect(putRecord({ ...r, rawTranscript: 'CHANGED' })).rejects.toThrow('生文字起こし');
    await putRecord({ ...r, confirmedTranscript: 'OK' });
    expect((await getRecord('a'))?.rawTranscript).toBe('RAW');
  });

  it('記録削除で音声も消える。音声だけの削除も可能', async () => {
    await putRecord(mk('a'));
    await putAudio({ id: 'a', blob: new Blob(['x']), mime: 'audio/mpeg' });
    await deleteAudio('a');
    expect(await getAudio('a')).toBeUndefined();
    expect(await getRecord('a')).toBeDefined();
    await putAudio({ id: 'a', blob: new Blob(['x']), mime: 'audio/mpeg' });
    await deleteRecord('a');
    expect(await getAudio('a')).toBeUndefined();
    expect(await getRecord('a')).toBeUndefined();
  });
});

describe('辞書・設定', () => {
  it('辞書の追加・編集・削除', async () => {
    await putDictionaryEntry({ id: '1', term: 'CGL', misrecognitions: [] });
    await putDictionaryEntry({ id: '1', term: 'CGL', misrecognitions: ['シージーエル'] });
    expect(await listDictionary()).toEqual([{ id: '1', term: 'CGL', misrecognitions: ['シージーエル'] }]);
    await deleteDictionaryEntry('1');
    expect(await listDictionary()).toEqual([]);
  });
  it('設定は既定値から始まり、部分更新できる。既定では自動開始OFF・音声自動削除ON', async () => {
    expect(await getSettings()).toMatchObject({ autoStart: false, autoDeleteAudio: true, accessToken: '' });
    expect(await patchSettings({ devMode: true })).toMatchObject({ devMode: true, autoStart: false });
  });
});

describe('JSONバックアップ', () => {
  it('エクスポート → 全消去 → インポートで復元でき、アクセストークンは含まれない', async () => {
    const r = mk('a');
    r.rawTranscript = 'RAW';
    r.outputs.minutes = { text: 'MIN', model: 'm', createdAt: 'x' };
    await putRecord(r);
    await putDictionaryEntry({ id: 'd1', term: 'CGL', misrecognitions: ['シージーエル'] });
    await patchSettings({ accessToken: 'SECRET-TOKEN-123' });
    const json = JSON.stringify(await buildBackup());
    expect(json).not.toContain('SECRET-TOKEN-123');
    await resetDBForTest();
    const sum = await importBackup(json);
    expect(sum).toEqual({ recordsAdded: 1, recordsSkipped: 0, dictionaryAdded: 1 });
    const restored = await getRecord('a');
    expect(restored?.rawTranscript).toBe('RAW');
    expect(restored?.outputs.minutes?.text).toBe('MIN');
    expect(restored?.audioDeleted).toBe(true); // 音声はバックアップに含まれない
    expect(await listDictionary()).toHaveLength(1);
  });
  it('既存IDは上書きせずスキップ', async () => {
    await putRecord({ ...mk('a'), title: '端末側' });
    const b = await buildBackup();
    b.records[0]!.title = 'バックアップ側';
    const sum = await importBackup(JSON.stringify(b));
    expect(sum.recordsSkipped).toBe(1);
    expect((await getRecord('a'))?.title).toBe('端末側');
  });
  it('不正データを拒否する', () => {
    expect(() => parseBackup('not json')).toThrow(BackupError);
    expect(() => parseBackup('{"app":"other"}')).toThrow('このアプリの');
    expect(() => parseBackup(JSON.stringify({ app: 'soundcore-transcript-pwa', version: 1, records: [{ id: 1 }], dictionary: [] }))).toThrow('履歴データ');
    expect(() => parseBackup(JSON.stringify({ app: 'soundcore-transcript-pwa', version: 9, records: [], dictionary: [] }))).toThrow('未対応');
  });
});
