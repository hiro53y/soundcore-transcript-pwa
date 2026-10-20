import type { JobView, OutputKind } from '@app/shared';
import { api, ApiError, describeError, uploadAudio } from './api';
import { applyCorrections, mergeCandidates } from './corrections';
import { deleteAudio, getAudio, getRecord, getSettings, listDictionary, notifyDB, putRecord } from './db';
import { dictionaryCandidates, toDictionaryContext } from './dictionary';
import type { RecordItem, StageState } from './types';

/**
 * 各段階（文字起こし / 校正候補 / 整文 / 成果物）を実行する。
 * - 同じ記録・同じ段階の同時実行は拒否（誤タップの二重送信 = 二重課金の防止）。
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

const POLL_MS = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function jobLabel(j: JobView): string {
  if (j.status === 'queued' || j.status === 'preparing') return '音声を準備中（圧縮・分割）';
  const total = j.chunks.length || 1;
  const done = j.chunks.filter((c) => c.status === 'done').length;
  return total > 1 ? `文字起こし中（${done}/${total}区間）` : '文字起こし中';
}

async function pollJob(id: string, jobId: string, pollMs = POLL_MS): Promise<JobView> {
  let misses = 0;
  for (;;) {
    let j: JobView;
    try {
      j = await api.getJob(jobId);
      misses = 0;
    } catch (e) {
      // 一時的な通信断は数回まで許容（圧縮・文字起こしはサーバー側で継続している）
      if (e instanceof ApiError && (e.code === 'offline' || e.code === 'network') && ++misses < 30) {
        setProgress(id, { label: '通信が途切れました。再接続を待っています…' });
        await sleep(pollMs * 2);
        continue;
      }
      throw e;
    }
    const total = j.chunks.length;
    const done = j.chunks.filter((c) => c.status === 'done').length;
    setProgress(id, { label: jobLabel(j), ratio: total ? done / total : undefined });
    await mutate(id, (r) => {
      r.jobProgress = total ? { done, total } : undefined;
    });
    if (j.status === 'done' || j.status === 'partial' || j.status === 'failed') return j;
    await sleep(pollMs);
  }
}

async function finishTranscription(id: string, j: JobView): Promise<void> {
  if (j.status === 'done' && typeof j.text === 'string') {
    const settings = await getSettings();
    await mutate(id, (r) => {
      if (r.rawTranscript === undefined) r.rawTranscript = j.text; // 生文字起こしは一度だけ保存
      r.stages.transcribe = stageOf('done');
      r.jobId = undefined;
      r.jobProgress = undefined;
      if (settings.autoDeleteAudio) r.audioDeleted = true;
    });
    if (settings.autoDeleteAudio) await deleteAudio(id);
    await api.deleteJob(j.id).catch(() => undefined);
    return;
  }
  if (j.status === 'partial') {
    const failed = j.chunks.filter((c) => c.status === 'failed').length;
    await mutate(id, (r) => {
      r.stages.transcribe = stageOf('error', `${failed}区間の文字起こしに失敗しました（成功した区間は保持されています）。「失敗した区間を再試行」を押してください。`);
      r.jobId = j.id;
    });
    return;
  }
  const msg = j.errorCode ?? 'internal';
  await mutate(id, (r) => {
    r.stages.transcribe = stageOf('error', failureMessage(msg));
    r.jobId = undefined;
    r.jobProgress = undefined;
  });
}

function failureMessage(code: string): string {
  const m: Record<string, string> = {
    provider_auth_failed: 'AIサービスの認証に失敗しました。サーバーのAPIキー設定を確認してください。',
    quota_exceeded: 'AIサービスの利用上限に達しました。利用枠・課金設定を確認してから再試行してください。',
    file_corrupt: '音声ファイルが壊れているか、読み取れませんでした。',
    file_too_large: '圧縮後も1区間が大きすぎて処理できませんでした。',
    rate_limited: 'AIサービスが混み合っています。少し待ってから再試行してください。',
    timeout: 'AIサービスの応答がタイムアウトしました。再試行してください。',
  };
  return m[code] ?? '文字起こしに失敗しました。再試行してください。';
}

/** 文字起こしを開始（またはサーバーに残っているジョブを再開）。 */
export function startTranscription(id: string, opts: { pollMs?: number } = {}): Promise<void | undefined> {
  return guarded(id, 'transcribe', async () => {
    const rec = await getRecord(id);
    if (!rec) return;
    if (rec.stages.transcribe.status === 'done') return; // 完了済みは再実行しない
    try {
      await mutate(id, (r) => {
        r.stages.transcribe = stageOf('running');
      });
      let jobId = rec.jobId;
      if (jobId) {
        // 再開: 部分失敗なら失敗区間のみ再試行、実行中ならそのまま追従
        try {
          const cur = await api.getJob(jobId);
          if (cur.status === 'partial') await api.retryJob(jobId);
        } catch (e) {
          if (e instanceof ApiError && e.code === 'job_not_found') jobId = undefined; // 期限切れ → 再アップロード
          else throw e;
        }
      }
      if (!jobId) {
        const audio = await getAudio(id);
        if (!audio) {
          await mutate(id, (r) => {
            r.stages.transcribe = stageOf('error', '音声データが端末にありません。もう一度MP3を選択してください。');
          });
          return;
        }
        const dict = toDictionaryContext(await listDictionary());
        setProgress(id, { label: 'アップロード中', ratio: 0 });
        const attempt = Date.now().toString(36);
        const job = await uploadAudio(audio.blob, {
          dictionary: dict,
          idempotencyKey: `${id}-${attempt}`,
          onProgress: (ratio) => setProgress(id, { label: 'アップロード中', ratio }),
        });
        jobId = job.id;
        await mutate(id, (r) => {
          r.jobId = job.id;
        });
      }
      const result = await pollJob(id, jobId, opts.pollMs);
      await finishTranscription(id, result);
    } catch (e) {
      await mutate(id, (r) => {
        r.stages.transcribe = stageOf('error', describeError(e));
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
      const ai = await api.proofread(rec.rawTranscript, toDictionaryContext(entries));
      await mutate(id, (r) => {
        r.corrections = mergeCandidates(r.corrections, [...local, ...ai.candidates]);
        r.stages.proofread = stageOf('done');
      });
    } catch (e) {
      await mutate(id, (r) => {
        r.stages.proofread = stageOf('error', describeError(e));
      });
    }
  });
}

/** 辞書だけの置換候補を追加（API不使用・無料）。 */
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
      const res = await api.polish(rec.confirmedTranscript, toDictionaryContext(await listDictionary()));
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
      const res = await api.generate(kind, rec.confirmedTranscript, rec.title, toDictionaryContext(await listDictionary()));
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

/** アプリ再起動で 'running' のまま残った段階を整理する。文字起こしはジョブIDがあれば再開可能。 */
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
