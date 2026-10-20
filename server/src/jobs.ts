import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ChunkInfo, DictionaryContext, JobStatus, JobView } from '@app/shared';
import { cutChunk, detectSilences, normalizeAudio, planChunks, type ChunkPlan } from './audio/split.js';
import { mergeChunks } from './audio/merge.js';
import type { Config } from './config.js';
import { AppError, isAppError } from './errors.js';
import { log } from './log.js';
import type { TranscriptionProvider } from './providers/types.js';

interface Job {
  id: string;
  dir: string;
  sourcePath: string;
  status: JobStatus;
  durationSec: number;
  plans: ChunkPlan[];
  chunks: ChunkInfo[];
  texts: (string | undefined)[];
  dictionary?: DictionaryContext;
  idempotencyKey?: string;
  errorCode?: AppError['code'];
  expiresAt?: number;
  /** 完了済みジョブの結果のみメモリ上に保持する期限。 */
  finishedAt?: number;
  running: boolean;
  dirRemoved: boolean;
  text?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 文字起こしジョブ管理。
 * 一時ファイル（アップロード原本・圧縮版・チャンク）は `tmpRoot/<uuid>/` にのみ置き、
 * 成功・失敗確定時に必ず削除する。一部失敗時のみ再試行用に jobTtlMs だけ保持する。
 */
export class JobManager {
  private jobs = new Map<string, Job>();
  private sweeper?: NodeJS.Timeout;

  constructor(
    private readonly cfg: Config,
    private readonly provider: TranscriptionProvider,
  ) {}

  /** 起動時: 前回プロセスが残した一時ディレクトリを全て削除し、定期掃除を開始する。 */
  async start(): Promise<void> {
    await mkdir(this.cfg.tmpRoot, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.cfg.tmpRoot)) {
      await rm(path.join(this.cfg.tmpRoot, name), { recursive: true, force: true });
    }
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref();
  }

  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    await Promise.all([...this.jobs.values()].map((j) => this.removeDir(j)));
    this.jobs.clear();
  }

  /** アップロード受信用の専用ディレクトリ（ランダム名・0700）を作る。ユーザー指定名はパスに使わない。 */
  async createUploadDir(): Promise<{ dir: string; sourcePath: string }> {
    await mkdir(this.cfg.tmpRoot, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(path.join(this.cfg.tmpRoot, 'job-'));
    return { dir, sourcePath: path.join(dir, 'source.bin') };
  }

  async discardUploadDir(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true });
  }

  findByIdempotencyKey(key: string): JobView | undefined {
    for (const j of this.jobs.values()) if (j.idempotencyKey === key) return this.view(j);
    return undefined;
  }

  create(input: { dir: string; sourcePath: string; durationSec: number; dictionary?: DictionaryContext; idempotencyKey?: string }): JobView {
    const job: Job = {
      id: randomUUID(),
      dir: input.dir,
      sourcePath: input.sourcePath,
      status: 'queued',
      durationSec: input.durationSec,
      plans: [],
      chunks: [],
      texts: [],
      dictionary: input.dictionary,
      idempotencyKey: input.idempotencyKey,
      running: false,
      dirRemoved: false,
    };
    this.jobs.set(job.id, job);
    log('job.created', { jobId: job.id, durationSec: Math.round(job.durationSec) });
    void this.run(job);
    return this.view(job);
  }

  get(id: string): JobView {
    const j = this.jobs.get(id);
    if (!j) throw new AppError('job_not_found');
    return this.view(j);
  }

  retry(id: string): JobView {
    const j = this.jobs.get(id);
    if (!j || j.dirRemoved) throw new AppError('job_not_found');
    if (j.running) throw new AppError('job_busy');
    if (j.status !== 'partial') throw new AppError('bad_request', '再試行できる状態ではありません。');
    for (const c of j.chunks) if (c.status === 'failed') c.status = 'pending';
    j.status = 'transcribing';
    j.errorCode = undefined;
    j.expiresAt = undefined;
    void this.run(j);
    return this.view(j);
  }

  async delete(id: string): Promise<void> {
    const j = this.jobs.get(id);
    if (!j) return;
    await this.removeDir(j);
    this.jobs.delete(id);
  }

  /** 期限切れジョブの一時ファイル・メモリ上の結果を削除する。 */
  async sweep(now = Date.now()): Promise<void> {
    for (const [id, j] of this.jobs) {
      if (j.running) continue;
      const expiry = j.expiresAt ?? (j.finishedAt ? j.finishedAt + this.cfg.jobTtlMs : undefined);
      if (expiry !== undefined && now >= expiry) {
        await this.removeDir(j);
        this.jobs.delete(id);
        log('job.expired', { jobId: id });
      }
    }
  }

  /** テスト用: 残っている一時ディレクトリ数。 */
  async tmpDirCount(): Promise<number> {
    try {
      return (await readdir(this.cfg.tmpRoot)).length;
    } catch {
      return 0;
    }
  }

  private view(j: Job): JobView {
    const done = j.status === 'done';
    const partial = j.status === 'partial';
    return {
      id: j.id,
      status: j.status,
      durationSec: j.durationSec,
      chunks: j.chunks.map((c) => ({ ...c, text: c.status === 'done' ? c.text : undefined })),
      text: done || partial ? j.text : undefined,
      errorCode: j.errorCode,
      retryable: partial && !j.dirRemoved,
      expiresAt: j.expiresAt ? new Date(j.expiresAt).toISOString() : undefined,
    };
  }

  private async removeDir(j: Job): Promise<void> {
    if (j.dirRemoved) return;
    j.dirRemoved = true;
    await rm(j.dir, { recursive: true, force: true });
  }

  private async run(j: Job): Promise<void> {
    j.running = true;
    const started = Date.now();
    try {
      if (j.plans.length === 0) await this.prepare(j);
      j.status = 'transcribing';
      await this.transcribeAll(j);
      const failed = j.chunks.filter((c) => c.status === 'failed');
      j.text = this.joined(j);
      // 終端状態を公開する「前に」一時ファイルを削除する（クライアントが状態を見た時点で必ず消えている）
      if (failed.length === 0) {
        await this.removeDir(j); // 成功時は即時削除（結果テキストのみTTLまでメモリ保持）
        j.status = 'done';
        j.finishedAt = Date.now();
      } else if (failed.every((c) => c.errorCode && !new AppError(c.errorCode).retryable)) {
        // 再試行しても無駄な失敗（認証・上限など）は保持せず削除
        await this.removeDir(j);
        j.status = 'failed';
        j.errorCode = failed[0]?.errorCode;
        j.finishedAt = Date.now();
      } else {
        j.status = 'partial';
        j.errorCode = 'partial_failure';
        j.expiresAt = Date.now() + this.cfg.jobTtlMs;
      }
      log('job.finished', { jobId: j.id, status: j.status, ms: Date.now() - started, chunks: j.chunks.length });
    } catch (e) {
      const code = isAppError(e) ? e.code : 'internal';
      log('job.failed', { jobId: j.id, code });
      await this.removeDir(j);
      j.status = 'failed';
      j.errorCode = code;
      j.finishedAt = Date.now();
    } finally {
      j.running = false;
    }
  }

  private async prepare(j: Job): Promise<void> {
    j.status = 'preparing';
    const norm = path.join(j.dir, 'normalized.mp3');
    await normalizeAudio(j.sourcePath, norm);
    await rm(j.sourcePath, { force: true }); // 原本は圧縮後すぐ削除
    const silences = await detectSilences(norm, j.durationSec);
    j.plans = planChunks(j.durationSec, silences, { targetSec: this.cfg.chunkTargetSec, overlapSec: this.cfg.chunkOverlapSec });
    j.chunks = j.plans.map((p) => ({ index: p.index, startSec: p.startSec, endSec: p.endSec, status: 'pending', attempts: 0 }));
    j.texts = new Array(j.plans.length).fill(undefined);
    for (const p of j.plans) {
      const out = this.chunkPath(j, p.index);
      if (j.plans.length === 1) {
        await rm(out, { force: true });
        // 単一チャンクは圧縮済みファイルをそのまま使う
        
        await rename(norm, out);
      } else {
        await cutChunk(norm, p, out);
      }
      const size = (await stat(out)).size;
      if (size > 24 * 1024 * 1024) throw new AppError('file_too_large', '圧縮後も1区間が25MBを超えたため処理できません。');
    }
    await rm(norm, { force: true });
  }

  private chunkPath(j: Job, i: number): string {
    return path.join(j.dir, `chunk-${String(i).padStart(4, '0')}.mp3`);
  }

  private async transcribeAll(j: Job): Promise<void> {
    const queue = j.chunks.filter((c) => c.status === 'pending');
    let fatal: AppError | undefined;
    const worker = async () => {
      while (!fatal) {
        const c = queue.shift();
        if (!c) return;
        await this.transcribeChunk(j, c);
        if (c.status === 'failed' && c.errorCode && !new AppError(c.errorCode).retryable) {
          fatal = new AppError(c.errorCode); // 認証・上限エラーは他チャンクでも同じなので打ち切る
        }
      }
    };
    await Promise.all(Array.from({ length: this.cfg.chunkConcurrency }, worker));
  }

  private async transcribeChunk(j: Job, c: ChunkInfo): Promise<void> {
    c.status = 'running';
    for (let attempt = 1; attempt <= this.cfg.chunkMaxAttempts; attempt++) {
      c.attempts++;
      try {
        const { text } = await this.provider.transcribe(this.chunkPath(j, c.index), {
          chunkIndex: c.index,
          dictionary: j.dictionary,
          language: this.cfg.transcribeLanguage || undefined,
        });
        c.status = 'done';
        c.text = text;
        j.texts[c.index] = text;
        c.errorCode = undefined;
        return;
      } catch (e) {
        const err = isAppError(e) ? e : new AppError('provider_error', undefined, { cause: e });
        c.errorCode = err.code;
        log('chunk.error', { jobId: j.id, chunk: c.index, attempt, code: err.code });
        if (!err.retryable || attempt === this.cfg.chunkMaxAttempts) break;
        await sleep(this.cfg.retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }
    c.status = 'failed';
  }

  private joined(j: Job): string {
    const parts = j.plans
      .map((p, i) => ({ startSec: p.startSec, text: j.texts[i], overlapsPrevious: p.overlapsPrevious }))
      .filter((x): x is { startSec: number; text: string; overlapsPrevious: boolean } => typeof x.text === 'string');
    return mergeChunks(parts);
  }
}
