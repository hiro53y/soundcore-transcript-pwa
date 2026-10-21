import type { OutputKind } from '@app/shared';
import { describeError } from './api';
import { applyCorrections, mergeCandidates } from './corrections';
import { deleteAudio, getAudio, getRecord, getSettings, listDictionary, notifyDB, putRecord } from './db';
import { dictionaryCandidates, toDictionaryContext } from './dictionary';
import { getTextEngine, getTranscribeEngine } from './engines';
import { PartialError } from './engines/types';
import type { RecordItem, StageState } from './types';

/**
 * 各段階（文字起こし / 校正候補 / 整文 / 成果物）を、設定で選ばれたエンジン経由で実行する。
 * - 同じ記録・同じ段階の同時実行は拒否（誤タップの二重送信 = 二重処理の防止）。
 * - 完了済みの段階は force 指定がなければ再実行しない。
 */
const inflight = new Set<string>();
export interface Progress {
  label: string;
  ratio?: number;
}
const progress = new Map<string, Progress>();

export function getProgress(id: string): Progress | undefined {
  return progress.get(id);
}
export function isRunning(id: string): boolean {
  return [...inflight].some((k) => k.startsWith(`${id}:`));
}
function setProgress(id: string, p: Progress | undefined) {
  if (p) progress.set(id, p);
  else progress.delete(id);
  notifyDB();
}

async function mutate(id: string, fn: (r: RecordItem) => RecordItem | void): Promise<RecordItem> {
  const rec = await getRecord(id);
  if (!rec) throw new Error('記録が見つかりません');
  const next = fn(rec) ?? rec;
  next.updatedAt = new Date().toISOString();
  await putRecord(next);
  return next;
}

const stageOf = (status: StageState['status'], error?: string): StageState => ({ status, error, at: new Date().toISOString() });

async function guarded<T>(id: string, stage: string, fn: () => Promise<T>): Promise<T | undefined> {
  const key = `${id}:${stage}`;
  if (inflight.has(key)) return undefined;
  inflight.add(key);
  try {
    return await fn();
  } finally {
    inflight.delete(key);
    setProgress(id, undefined);
  }
}

// ---------------- 文字起こし ----------------

/** 長い処理中に画面が消えて処理が止まらないよう、対応ブラウザでは画面をつけたままにする（任意・失敗しても続行）。 */
async function acquireWakeLock(): Promise<() => void> {
  try {
    const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    const lock = await wl?.request('screen');
    return () => void lock?.release().catch(() => undefined);
  } catch {
    return () => undefined;
  }
}

/** 文字起こしを開始（またはサーバー方式でジョブを再開）。 */
export function startTranscription(id: string, opts: { pollMs?: number } = {}): Promise<void | undefined> {
  return guarded(id, 'transcribe', async () => {
    const rec = await getRecord(id);
    if (!rec) return;
    if (rec.stages.transcribe.status === 'done') return; // 完了済みは再実行しない
    try {
      const settings = await getSettings();
      const engine = getTranscribeEngine(settings);
      const audio = await getAudio(id);
      const resumeJobId = engine.id === 'server' ? rec.jobId : undefined;
      if (!audio && !resumeJobId) {
        await mutate(id, (r) => {
          r.stages.transcribe = stageOf('error', '音声データが端末にありません。もう一度MP3を選択してください。');
        });
        return;
      }
      const blocked = engine.preflight?.({ durationSec: rec.durationSec, size: rec.fileSize });
      if (blocked) {
        await mutate(id, (r) => {
          r.stages.transcribe = stageOf('error', blocked);
        });
        return;
      }
      await mutate(id, (r) => {
        r.stages.transcribe = stageOf('running');
      });
      const releaseLock = await acquireWakeLock();
      const text = await engine.transcribe({
        recordId: id,
        blob: audio?.blob,
        durationSec: rec.durationSec,
        dictionary: toDictionaryContext(await listDictionary()),
        resumeJobId,
        pollMs: opts.pollMs,
        onJob: (jobId) => void mutate(id, (r) => void (r.jobId = jobId)),
        onProgress: (p) => {
          setProgress(id, { label: p.label, ratio: p.ratio });
          if (p.chunks) void mutate(id, (r) => void (r.jobProgress = p.chunks));
        },
      }).finally(releaseLock);
      await mutate(id, (r) => {
        if (r.rawTranscript === undefined) r.rawTranscript = text; // 生文字起こしは一度だけ保存
        r.stages.transcribe = stageOf('done');
        r.jobId = undefined;
        r.jobProgress = undefined;
        if (settings.autoDeleteAudio) r.audioDeleted = true;
      });
      if (settings.autoDeleteAudio) await deleteAudio(id);
    } catch (e) {
      const partial = e instanceof PartialError ? e : undefined;
      await mutate(id, (r) => {
        r.stages.transcribe = stageOf('error', partial ? partial.message : describeError(e));
        if (partial) r.jobId = partial.jobId;
        else if (r.jobId && (e as { name?: string })?.name === 'EngineError') r.jobId = undefined;
      });
    }
  });
}

// ---------------- 校正候補 / 整文 / 成果物 ----------------

export function runProofread(id: string, force = false): Promise<void | undefined> {
  return guarded(id, 'proofread', async () => {
    const rec = await getRecord(id);
    if (!rec?.rawTranscript) return;
    if (rec.stages.proofread.status === 'done' && !force) return;
    await mutate(id, (r) => {
      r.stages.proofread = stageOf('running');
    });
    try {
      setProgress(id, { label: '校正候補を生成中' });
      const entries = await listDictionary();
      const local = dictionaryCandidates(rec.rawTranscript, entries);
      const engine = getTextEngine(await getSettings());
      const ai = await engine.proofread(rec.rawTranscript, toDictionaryContext(entries));
      await mutate(id, (r) => {
        r.corrections = mergeCandidates(r.corrections, [...local, ...ai]);
        r.stages.proofread = stageOf('done');
      });
    } catch (e) {
      await mutate(id, (r) => {
        r.stages.proofread = stageOf('error', describeError(e));
      });
    }
  });
}

/** 辞書だけの置換候補を追加（AI不使用・無料）。 */
export async function addDictionaryCandidates(id: string): Promise<number> {
  const rec = await getRecord(id);
  if (!rec?.rawTranscript) return 0;
  const cands = dictionaryCandidates(rec.rawTranscript, await listDictionary());
  const next = await mutate(id, (r) => {
    r.corrections = mergeCandidates(r.corrections, cands);
  });
  return next.corrections.length - rec.corrections.length;
}

export async function confirmTranscript(id: string, text: string): Promise<void> {
  await mutate(id, (r) => {
    r.confirmedTranscript = text;
    r.confirmedAt = new Date().toISOString();
  });
}

/** 候補の採否を反映した現在の作業テキスト（手動編集があればそれを優先）。 */
export function workingText(rec: RecordItem): string {
  if (rec.manualEdit !== undefined) return rec.manualEdit;
  return applyCorrections(rec.rawTranscript ?? '', rec.corrections);
}

export function runPolish(id: string, force = false): Promise<void | undefined> {
  return guarded(id, 'polish', async () => {
    const rec = await getRecord(id);
    if (!rec?.confirmedTranscript) return;
    if (rec.stages.polish.status === 'done' && !force) return;
    await mutate(id, (r) => {
      r.stages.polish = stageOf('running');
    });
    try {
      setProgress(id, { label: '整文中' });
      const engine = getTextEngine(await getSettings());
      const res = await engine.polish(rec.confirmedTranscript, toDictionaryContext(await listDictionary()));
      await mutate(id, (r) => {
        r.polished = { text: res.text, model: res.model, createdAt: new Date().toISOString() };
        r.stages.polish = stageOf('done');
      });
    } catch (e) {
      await mutate(id, (r) => {
        r.stages.polish = stageOf('error', describeError(e));
      });
    }
  });
}

export function runGenerate(id: string, kind: OutputKind, force = false): Promise<void | undefined> {
  return guarded(id, `gen-${kind}`, async () => {
    const rec = await getRecord(id);
    if (!rec?.confirmedTranscript) return;
    if (rec.stages.outputs[kind]?.status === 'done' && !force) return;
    await mutate(id, (r) => {
      r.stages.outputs[kind] = stageOf('running');
    });
    try {
      setProgress(id, { label: '生成中' });
      const engine = getTextEngine(await getSettings());
      const res = await engine.generate(kind, rec.confirmedTranscript, rec.title, toDictionaryContext(await listDictionary()));
      await mutate(id, (r) => {
        r.outputs[kind] = { text: res.text, model: res.model, createdAt: new Date().toISOString() };
        r.stages.outputs[kind] = stageOf('done');
      });
    } catch (e) {
      await mutate(id, (r) => {
        r.stages.outputs[kind] = stageOf('error', describeError(e));
      });
    }
  });
}

/** アプリ再起動で 'running' のまま残った段階を整理する。server方式の文字起こしはジョブIDがあれば再開可能。 */
export async function recoverStaleStages(records: RecordItem[]): Promise<void> {
  for (const r of records) {
    if (isRunning(r.id)) continue;
    const stale = (s: StageState | undefined) => s?.status === 'running';
    if (![r.stages.transcribe, r.stages.proofread, r.stages.polish, ...Object.values(r.stages.outputs)].some(stale)) continue;
    await mutate(r.id, (x) => {
      const interrupted = stageOf('error', '処理が中断されました。もう一度実行してください。');
      if (stale(x.stages.transcribe)) x.stages.transcribe = x.jobId ? stageOf('idle') : interrupted;
      if (stale(x.stages.proofread)) x.stages.proofread = interrupted;
      if (stale(x.stages.polish)) x.stages.polish = interrupted;
      for (const k of Object.keys(x.stages.outputs) as OutputKind[]) if (stale(x.stages.outputs[k])) x.stages.outputs[k] = interrupted;
    });
  }
}
