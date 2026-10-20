import { getDB, getSettings, listDictionary, listRecords, notifyDB } from './db';
import type { BackupFile, DictionaryEntry, RecordItem } from './types';

export async function buildBackup(): Promise<BackupFile> {
  const { accessToken: _omit, ...settings } = await getSettings();
  return {
    app: 'soundcore-transcript-pwa',
    version: 1,
    exportedAt: new Date().toISOString(),
    records: await listRecords(),
    dictionary: await listDictionary(),
    settings,
  };
}

export class BackupError extends Error {}

function isRecord(r: unknown): r is RecordItem {
  const o = r as RecordItem;
  return !!o && typeof o.id === 'string' && typeof o.title === 'string' && typeof o.createdAt === 'string' && typeof o.stages === 'object' && Array.isArray(o.corrections);
}
function isEntry(e: unknown): e is DictionaryEntry {
  const o = e as DictionaryEntry;
  return !!o && typeof o.id === 'string' && typeof o.term === 'string' && Array.isArray(o.misrecognitions);
}

export function parseBackup(text: string): BackupFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BackupError('JSONとして読み取れませんでした。');
  }
  const b = data as BackupFile;
  if (!b || b.app !== 'soundcore-transcript-pwa') throw new BackupError('このアプリのバックアップファイルではありません。');
  if (b.version !== 1) throw new BackupError('未対応のバックアップ形式です。');
  if (!Array.isArray(b.records) || !b.records.every(isRecord)) throw new BackupError('履歴データの形式が正しくありません。');
  if (!Array.isArray(b.dictionary) || !b.dictionary.every(isEntry)) throw new BackupError('辞書データの形式が正しくありません。');
  return b;
}

export interface ImportSummary {
  recordsAdded: number;
  recordsSkipped: number;
  dictionaryAdded: number;
}

/**
 * バックアップを取り込む。既存の同一IDは上書きしない（端末内データを守る）。
 * 実行中のまま保存されていた段階は「中断」扱いにする。音声はバックアップに含まれない。
 */
export async function importBackup(text: string): Promise<ImportSummary> {
  const b = parseBackup(text);
  const db = await getDB();
  const tx = db.transaction(['records', 'dictionary'], 'readwrite');
  let recordsAdded = 0;
  let recordsSkipped = 0;
  let dictionaryAdded = 0;
  for (const r of b.records) {
    if (await tx.objectStore('records').get(r.id)) {
      recordsSkipped++;
      continue;
    }
    await tx.objectStore('records').put({ ...r, audioDeleted: true, jobId: undefined });
    recordsAdded++;
  }
  for (const e of b.dictionary) {
    if (await tx.objectStore('dictionary').get(e.id)) continue;
    await tx.objectStore('dictionary').put(e);
    dictionaryAdded++;
  }
  await tx.done;
  notifyDB();
  return { recordsAdded, recordsSkipped, dictionaryAdded };
}
