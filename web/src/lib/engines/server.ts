import type { JobView } from '@app/shared';
import { api, ApiError, uploadAudio } from '../api';
import { EngineError, PartialError, type EngineProgress, type TextEngine, type TranscribeEngine, type TranscribeInput } from './types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function jobLabel(j: JobView): string {
  if (j.status === 'queued' || j.status === 'preparing') return '音声を準備中（圧縮・分割）';
  const total = j.chunks.length || 1;
  const done = j.chunks.filter((c) => c.status === 'done').length;
  return total > 1 ? `文字起こし中（${done}/${total}区間）` : '文字起こし中';
}

async function pollJob(jobId: string, onProgress: (p: EngineProgress) => void, pollMs: number): Promise<JobView> {
  let misses = 0;
  for (;;) {
    let j: JobView;
    try {
      j = await api.getJob(jobId);
      misses = 0;
    } catch (e) {
      // 一時的な通信断は数回まで許容（圧縮・文字起こしはサーバー側で継続している）
      if (e instanceof ApiError && (e.code === 'offline' || e.code === 'network') && ++misses < 30) {
        onProgress({ label: '通信が途切れました。再接続を待っています…' });
        await sleep(pollMs * 2);
        continue;
      }
      throw e;
    }
    const total = j.chunks.length;
    const done = j.chunks.filter((c) => c.status === 'done').length;
    onProgress({ label: jobLabel(j), ratio: total ? done / total : undefined, chunks: total ? { done, total } : undefined });
    if (j.status === 'done' || j.status === 'partial' || j.status === 'failed') return j;
    await sleep(pollMs);
  }
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

/** 自前サーバー(self-host)経由。v1の構成。音声はサーバーへ送られ、サーバーのOpenAIキーで処理される。 */
export const serverTranscribeEngine: TranscribeEngine = {
  id: 'server',
  async transcribe(input: TranscribeInput): Promise<string> {
    const pollMs = input.pollMs ?? 2000;
    let jobId = input.resumeJobId;
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
      if (!input.blob) throw new EngineError('音声データが端末にありません。もう一度MP3を選択してください。');
      input.onProgress({ label: 'アップロード中', ratio: 0 });
      const job = await uploadAudio(input.blob, {
        dictionary: input.dictionary,
        idempotencyKey: `${input.recordId}-${Date.now().toString(36)}`,
        onProgress: (ratio) => input.onProgress({ label: 'アップロード中', ratio }),
      });
      jobId = job.id;
      input.onJob?.(job.id);
    }
    const j = await pollJob(jobId, input.onProgress, pollMs);
    if (j.status === 'done' && typeof j.text === 'string') {
      await api.deleteJob(j.id).catch(() => undefined);
      return j.text;
    }
    if (j.status === 'partial') {
      const failed = j.chunks.filter((c) => c.status === 'failed').length;
      throw new PartialError(`${failed}区間の文字起こしに失敗しました（成功した区間は保持されています）。「失敗した区間を再試行」を押してください。`, j.id);
    }
    throw new EngineError(failureMessage(j.errorCode ?? 'internal'));
  },
};

export const serverTextEngine: TextEngine = {
  id: 'server',
  async proofread(text, dictionary) {
    return (await api.proofread(text, dictionary)).candidates;
  },
  polish: (text, dictionary) => api.polish(text, dictionary),
  generate: (kind, text, title, dictionary) => api.generate(kind, text, title, dictionary),
};
