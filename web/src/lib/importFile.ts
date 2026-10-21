import { isAcceptedAudioType, sniffAudio } from '@app/shared';
import { deleteAudio, findByFingerprint, getDB, notifyDB, putAudio, putRecord } from './db';
import { purgeExpiredInbox } from './share';
import type { RecordItem } from './types';

export const HARD_MAX_BYTES = 1024 * 1024 * 1024;

export type ImportFailure = 'empty' | 'too_large' | 'not_audio' | 'unreadable';
export type ImportResult =
  | { kind: 'created'; record: RecordItem }
  | { kind: 'duplicate'; record: RecordItem }
  | { kind: 'invalid'; reason: ImportFailure; message: string };

export const IMPORT_MESSAGES: Record<ImportFailure, string> = {
  empty: 'ファイルが空（0バイト）です。共有元アプリでの書き出しをやり直してください。',
  too_large: 'ファイルが大きすぎます。',
  not_audio: 'MP3などの音声ファイルとして認識できませんでした。Soundcoreアプリで「MP3」形式で書き出したか確認してください。',
  unreadable: 'ファイルを読み取れませんでした。もう一度共有・選択してください。',
};

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** サイズ + 先頭/中央/末尾2MBのSHA-256。巨大ファイルを丸ごと読まずに同一性を判定する。 */
export async function fingerprintOf(blob: Blob): Promise<string> {
  const W = 2 * 1024 * 1024;
  const size = blob.size;
  const slices = [blob.slice(0, W)];
  if (size > W * 2) slices.push(blob.slice(Math.floor(size / 2 - W / 2), Math.floor(size / 2 + W / 2)));
  if (size > W) slices.push(blob.slice(Math.max(W, size - W), size));
  const bufs = await Promise.all(slices.map((s) => s.arrayBuffer()));
  const total = new Uint8Array(bufs.reduce((n, b) => n + b.byteLength, 0));
  let off = 0;
  for (const b of bufs) {
    total.set(new Uint8Array(b), off);
    off += b.byteLength;
  }
  return `${size}-${await sha256Hex(total.buffer)}`;
}

/** 長さ(秒)の取得。デコードできなければ undefined（確認画面では「不明」と表示）。 */
export function readDuration(blob: Blob, timeoutMs = 8000): Promise<number | undefined> {
  return new Promise((resolve) => {
    if (typeof Audio === 'undefined' || typeof URL.createObjectURL !== 'function') return resolve(undefined);
    const url = URL.createObjectURL(blob);
    const a = new Audio();
    const done = (v: number | undefined) => {
      clearTimeout(timer);
      URL.revokeObjectURL(url);
      a.removeAttribute('src');
      resolve(v);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    a.preload = 'metadata';
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) && a.duration > 0 ? a.duration : undefined);
    a.onerror = () => done(undefined);
    a.src = url;
  });
}

export function titleFromFileName(name: string): string {
  const t = name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  return t || '無題の録音';
}

export function newRecord(init: { id: string; fileName: string; fileSize: number; durationSec?: number; fingerprint: string; source: 'share' | 'picker'; now: string }): RecordItem {
  return {
    id: init.id,
    title: titleFromFileName(init.fileName),
    fileName: init.fileName,
    fileSize: init.fileSize,
    durationSec: init.durationSec,
    createdAt: init.now,
    updatedAt: init.now,
    source: init.source,
    fingerprint: init.fingerprint,
    stages: { transcribe: { status: 'idle' }, proofread: { status: 'idle' }, polish: { status: 'idle' }, outputs: {} },
    corrections: [],
    outputs: {},
    audioDeleted: false,
  };
}

/** 検証（拡張子/MIME/サイズ/先頭バイト）。実際のデコード可否はサーバー側のffprobeで最終確認する。 */
export async function validateClientSide(file: Blob, name: string, mime: string): Promise<ImportFailure | null> {
  if (file.size === 0) return 'empty';
  if (file.size > HARD_MAX_BYTES) return 'too_large';
  if (!isAcceptedAudioType(name, mime)) return 'not_audio';
  try {
    const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    if (!sniffAudio(head)) return 'not_audio';
  } catch {
    return 'unreadable';
  }
  return null;
}

/** 通常のファイル選択・共有受信の共通の取り込み処理。重複（同一指紋）は新規作成しない。 */
export async function importAudio(
  file: Blob,
  meta: { name: string; mime: string; source: 'share' | 'picker' },
  deps: { now?: () => Date; newId?: () => string } = {},
): Promise<ImportResult> {
  const reason = await validateClientSide(file, meta.name, meta.mime);
  if (reason) return { kind: 'invalid', reason, message: IMPORT_MESSAGES[reason] };
  let fingerprint: string;
  try {
    fingerprint = await fingerprintOf(file);
  } catch {
    return { kind: 'invalid', reason: 'unreadable', message: IMPORT_MESSAGES.unreadable };
  }
  const dup = await findByFingerprint(fingerprint);
  if (dup) return { kind: 'duplicate', record: dup };
  const durationSec = await readDuration(file);
  const id = (deps.newId ?? (() => crypto.randomUUID()))();
  const rec = newRecord({
    id,
    fileName: meta.name,
    fileSize: file.size,
    durationSec,
    fingerprint,
    source: meta.source,
    now: (deps.now ?? (() => new Date()))().toISOString(),
  });
  try {
    await putAudio({ id, blob: file, mime: meta.mime || 'audio/mpeg' });
    await putRecord(rec);
  } catch (e) {
    await deleteAudio(id).catch(() => undefined);
    throw new StorageError('端末内への保存に失敗しました。空き容量を確認してください。', e);
  }
  return { kind: 'created', record: rec };
}

export class StorageError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'StorageError';
  }
}

export type ShareOutcome = { id: string; result: ImportResult | { kind: 'missing' }; meta?: { name: string; mime: string; size: number; receivedAt: number } };

/**
 * `/?share=<id>` で戻ってきたページ側の処理。
 * 受信箱から取り出して取り込み、**成功・失敗を問わず受信箱の行を削除**する（再読み込みで再処理されない）。
 */
export async function consumeShares(ids: string[]): Promise<ShareOutcome[]> {
  const db = await getDB();
  const out: ShareOutcome[] = [];
  for (const id of ids) {
    const row = await db.get('shareInbox', id);
    if (!row) {
      out.push({ id, result: { kind: 'missing' } });
      continue;
    }
    try {
      const result = await importAudio(row.file, { name: row.fileName, mime: row.mime, source: 'share' });
      out.push({ id, result, meta: { name: row.fileName, mime: row.mime, size: row.size, receivedAt: row.receivedAt } });
    } finally {
      await db.delete('shareInbox', id);
    }
  }
  await purgeExpiredInbox(db, Date.now());
  notifyDB();
  return out;
}
