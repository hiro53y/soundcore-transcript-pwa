import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AudioRow, DictionaryEntry, RecordItem, Settings, ShareInboxRow } from './types';
import { DEFAULT_SETTINGS } from './types';

interface Schema extends DBSchema {
  records: { key: string; value: RecordItem; indexes: { byCreated: string; byFingerprint: string } };
  audio: { key: string; value: AudioRow };
  dictionary: { key: string; value: DictionaryEntry };
  settings: { key: string; value: unknown };
  shareInbox: { key: string; value: ShareInboxRow; indexes: { byReceived: number } };
}

export const DB_NAME = 'soundcore-transcript';
export const DB_VERSION = 1;

export type AppDB = IDBPDatabase<Schema>;

/** Service Worker とページの両方から使う。スキーマ定義はここだけに置く。 */
export function openAppDB(name = DB_NAME): Promise<AppDB> {
  return openDB<Schema>(name, DB_VERSION, {
    upgrade(db) {
      const r = db.createObjectStore('records', { keyPath: 'id' });
      r.createIndex('byCreated', 'createdAt');
      r.createIndex('byFingerprint', 'fingerprint');
      db.createObjectStore('audio', { keyPath: 'id' });
      db.createObjectStore('dictionary', { keyPath: 'id' });
      db.createObjectStore('settings');
      const s = db.createObjectStore('shareInbox', { keyPath: 'id' });
      s.createIndex('byReceived', 'receivedAt');
    },
  });
}

let dbPromise: Promise<AppDB> | undefined;
export function getDB(): Promise<AppDB> {
  dbPromise ??= openAppDB();
  return dbPromise;
}
/** テスト用: 接続を閉じて作り直す。 */
export async function resetDBForTest(name = DB_NAME): Promise<void> {
  if (dbPromise) (await dbPromise).close();
  dbPromise = undefined;
  await new Promise<void>((res) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = req.onblocked = () => res();
  });
}

type Listener = () => void;
const listeners = new Set<Listener>();
export function subscribeDB(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function notifyDB(): void {
  for (const l of listeners) l();
}

// ---- records ----
export async function putRecord(rec: RecordItem): Promise<void> {
  const db = await getDB();
  const prev = await db.get('records', rec.id);
  // 生文字起こしは不変: 既に保存済みなら上書きを拒否する
  if (prev?.rawTranscript !== undefined && rec.rawTranscript !== prev.rawTranscript) {
    throw new Error('生文字起こしは変更できません');
  }
  await db.put('records', rec);
  notifyDB();
}

export async function getRecord(id: string): Promise<RecordItem | undefined> {
  return (await getDB()).get('records', id);
}

export async function listRecords(): Promise<RecordItem[]> {
  const all = await (await getDB()).getAllFromIndex('records', 'byCreated');
  return all.reverse();
}

export async function findByFingerprint(fp: string): Promise<RecordItem | undefined> {
  return (await getDB()).getFromIndex('records', 'byFingerprint', fp);
}

export async function deleteRecord(id: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['records', 'audio'], 'readwrite');
  await Promise.all([tx.objectStore('records').delete(id), tx.objectStore('audio').delete(id), tx.done]);
  notifyDB();
}

// ---- audio ----
export async function putAudio(row: AudioRow): Promise<void> {
  await (await getDB()).put('audio', row);
}
export async function getAudio(id: string): Promise<AudioRow | undefined> {
  return (await getDB()).get('audio', id);
}
export async function deleteAudio(id: string): Promise<void> {
  await (await getDB()).delete('audio', id);
  notifyDB();
}

// ---- dictionary ----
export async function listDictionary(): Promise<DictionaryEntry[]> {
  return (await getDB()).getAll('dictionary');
}
export async function putDictionaryEntry(e: DictionaryEntry): Promise<void> {
  await (await getDB()).put('dictionary', e);
  notifyDB();
}
export async function deleteDictionaryEntry(id: string): Promise<void> {
  await (await getDB()).delete('dictionary', id);
  notifyDB();
}

// ---- settings ----
export async function getSettings(): Promise<Settings> {
  const db = await getDB();
  const all = await db.getAllKeys('settings');
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const k of all) out[String(k)] = await db.get('settings', k);
  return out as unknown as Settings;
}
export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  const db = await getDB();
  const tx = db.transaction('settings', 'readwrite');
  for (const [k, v] of Object.entries(patch)) await tx.store.put(v, k);
  await tx.done;
  notifyDB();
  return getSettings();
}
