import type { JobView } from '@app/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/api', async (orig) => {
  const real = await orig<typeof import('../src/lib/api')>();
  return {
    ...real,
    uploadAudio: vi.fn(),
    api: { config: vi.fn(), getJob: vi.fn(), retryJob: vi.fn(), deleteJob: vi.fn(async () => undefined), proofread: vi.fn(), polish: vi.fn(), generate: vi.fn() },
  };
});

import { ApiError, api, uploadAudio } from '../src/lib/api';
import { getAudio, getRecord, patchSettings, putDictionaryEntry } from '../src/lib/db';
import { importAudio } from '../src/lib/importFile';
import { confirmTranscript, recoverStaleStages, runGenerate, runPolish, runProofread, startTranscription } from '../src/lib/pipeline';
import { putRecord } from '../src/lib/db';
import { mp3File } from './helpers';

const job = (over: Partial<JobView> = {}): JobView => ({ id: 'job1', status: 'done', chunks: [{ index: 0, startSec: 0, endSec: 5, status: 'done', attempts: 1 }], text: 'RAW TEXT', retryable: false, ...over });

async function newRec() {
  const f = mp3File();
  const r = await importAudio(f, { name: f.name, mime: f.type, source: 'picker' });
  if (r.kind !== 'created') throw new Error('x');
  return r.record.id;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.deleteJob).mockResolvedValue(undefined);
});

describe('文字起こしパイプライン', () => {
  it('成功すると生文字起こしを保存し、設定に従い音声を削除、サーバージョブも削除', async () => {
    const id = await newRec();
    vi.mocked(uploadAudio).mockResolvedValue(job({ status: 'queued', text: undefined }));
    vi.mocked(api.getJob).mockResolvedValue(job());
    await startTranscription(id, { pollMs: 1 });
    const r = await getRecord(id);
    expect(r?.rawTranscript).toBe('RAW TEXT');
    expect(r?.confirmedTranscript).toBeUndefined(); // 生と確認済みは別データ
    expect(r?.stages.transcribe.status).toBe('done');
    expect(r?.audioDeleted).toBe(true);
    expect(await getAudio(id)).toBeUndefined();
    expect(api.deleteJob).toHaveBeenCalledWith('job1');
  });

  it('自動削除OFFなら音声を残す', async () => {
    await patchSettings({ autoDeleteAudio: false });
    const id = await newRec();
    vi.mocked(uploadAudio).mockResolvedValue(job());
    vi.mocked(api.getJob).mockResolvedValue(job());
    await startTranscription(id, { pollMs: 1 });
    expect(await getAudio(id)).toBeDefined();
  });

  it('連打しても送信は1回（二重送信防止）、完了後の再実行もしない', async () => {
    const id = await newRec();
    vi.mocked(uploadAudio).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return job();
    });
    vi.mocked(api.getJob).mockResolvedValue(job());
    await Promise.all([startTranscription(id, { pollMs: 1 }), startTranscription(id, { pollMs: 1 }), startTranscription(id, { pollMs: 1 })]);
    expect(uploadAudio).toHaveBeenCalledTimes(1);
    await startTranscription(id, { pollMs: 1 });
    expect(uploadAudio).toHaveBeenCalledTimes(1);
  });

  it('辞書を送信し、アップロード失敗は日本語メッセージで保持、再試行で成功できる', async () => {
    await putDictionaryEntry({ id: 'd', term: 'CGL', misrecognitions: ['シージーエル'] });
    const id = await newRec();
    vi.mocked(uploadAudio).mockRejectedValueOnce(new ApiError('network', 'サーバーに接続できませんでした。', true));
    await startTranscription(id, { pollMs: 1 });
    let r = await getRecord(id);
    expect(r?.stages.transcribe).toMatchObject({ status: 'error', error: 'サーバーに接続できませんでした。' });
    expect(r?.rawTranscript).toBeUndefined();
    expect(await getAudio(id)).toBeDefined(); // 失敗時に音声を消さない
    expect(vi.mocked(uploadAudio).mock.calls[0]![1].dictionary?.terms[0]?.term).toBe('CGL');

    vi.mocked(uploadAudio).mockResolvedValueOnce(job());
    vi.mocked(api.getJob).mockResolvedValue(job());
    await startTranscription(id, { pollMs: 1 });
    r = await getRecord(id);
    expect(r?.stages.transcribe.status).toBe('done');
  });

  it('一部チャンク失敗は保持し、再開時はアップロードせず失敗区間のみ再試行', async () => {
    const id = await newRec();
    const partial = job({ status: 'partial', retryable: true, chunks: [{ index: 0, startSec: 0, endSec: 5, status: 'done', attempts: 1, text: 'a' }, { index: 1, startSec: 5, endSec: 10, status: 'failed', attempts: 3 }], text: 'a' });
    vi.mocked(uploadAudio).mockResolvedValue(partial);
    vi.mocked(api.getJob).mockResolvedValue(partial);
    await startTranscription(id, { pollMs: 1 });
    let r = await getRecord(id);
    expect(r?.stages.transcribe.status).toBe('error');
    expect(r?.stages.transcribe.error).toContain('1区間');
    expect(r?.jobId).toBe('job1');

    vi.mocked(api.retryJob).mockResolvedValue(partial);
    vi.mocked(api.getJob).mockResolvedValueOnce(partial).mockResolvedValue(job({ text: 'a\n\nb' }));
    await startTranscription(id, { pollMs: 1 });
    expect(uploadAudio).toHaveBeenCalledTimes(1); // 再アップロードしていない
    expect(api.retryJob).toHaveBeenCalledWith('job1');
    r = await getRecord(id);
    expect(r?.rawTranscript).toBe('a\n\nb');
  });

  it('サーバー側の保持期限切れ(job_not_found)なら再アップロードする', async () => {
    const id = await newRec();
    const rec = (await getRecord(id))!;
    await putRecord({ ...rec, jobId: 'stale' });
    vi.mocked(api.getJob).mockRejectedValueOnce(new ApiError('job_not_found', '期限切れ')).mockResolvedValue(job());
    vi.mocked(uploadAudio).mockResolvedValue(job());
    await startTranscription(id, { pollMs: 1 });
    expect(uploadAudio).toHaveBeenCalledTimes(1);
  });

  it('認証失敗などの恒久エラーは再試行を促す文言で保存', async () => {
    const id = await newRec();
    vi.mocked(uploadAudio).mockResolvedValue(job({ status: 'queued', text: undefined }));
    vi.mocked(api.getJob).mockResolvedValue(job({ status: 'failed', errorCode: 'provider_auth_failed', text: undefined }));
    await startTranscription(id, { pollMs: 1 });
    expect((await getRecord(id))?.stages.transcribe.error).toContain('認証');
  });
});

describe('校正・整文・議事録（各段階は別データ・再実行は明示操作のみ）', () => {
  async function transcribed() {
    const id = await newRec();
    vi.mocked(uploadAudio).mockResolvedValue(job());
    vi.mocked(api.getJob).mockResolvedValue(job({ text: '足ポンプを変更した。シージーエルを確認。' }));
    await startTranscription(id, { pollMs: 1 });
    return id;
  }

  it('AI候補と辞書候補をマージ。AIは本文を変更しない', async () => {
    await putDictionaryEntry({ id: 'd', term: 'CGL', misrecognitions: ['シージーエル'] });
    const id = await transcribed();
    vi.mocked(api.proofread).mockResolvedValue({ candidates: [{ id: 'x', original: '足ポンプ', suggestion: 'アッシュポンプ', reason: 'r', confidence: 'medium', source: 'ai' }] });
    await runProofread(id);
    const r = await getRecord(id);
    expect(r?.corrections.map((c) => `${c.source}:${c.original}`).sort()).toEqual(['ai:足ポンプ', 'dictionary:シージーエル']);
    expect(r?.corrections.every((c) => c.decision === 'pending')).toBe(true);
    expect(r?.rawTranscript).toBe('足ポンプを変更した。シージーエルを確認。');
    await runProofread(id); // 完了済みは再実行しない
    expect(api.proofread).toHaveBeenCalledTimes(1);
  });

  it('整文は確認済み文字起こしを入力にし、生・確認済みを上書きしない', async () => {
    const id = await transcribed();
    await runPolish(id); // 確認前は何もしない
    expect(api.polish).not.toHaveBeenCalled();
    await confirmTranscript(id, 'アッシュポンプを変更した。CGLを確認。');
    vi.mocked(api.polish).mockResolvedValue({ text: '整文結果', model: 'm1' });
    await runPolish(id);
    await runPolish(id);
    expect(api.polish).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.polish).mock.calls[0]![0]).toBe('アッシュポンプを変更した。CGLを確認。');
    const r = await getRecord(id);
    expect([r?.rawTranscript, r?.confirmedTranscript, r?.polished?.text]).toEqual(['足ポンプを変更した。シージーエルを確認。', 'アッシュポンプを変更した。CGLを確認。', '整文結果']);
    await runPolish(id, true); // 明示の再生成のみ再実行
    expect(api.polish).toHaveBeenCalledTimes(2);
  });

  it('議事録等は種類ごとに別データ。失敗はその種類にだけ記録され他は影響しない', async () => {
    const id = await transcribed();
    await confirmTranscript(id, '確認済み本文');
    vi.mocked(api.generate).mockImplementation(async (kind) => {
      if (kind === 'todos') throw new ApiError('quota_exceeded', '利用上限に達しました');
      return { text: `${kind}-out`, model: 'm' };
    });
    await runGenerate(id, 'minutes');
    await runGenerate(id, 'summary');
    await runGenerate(id, 'todos');
    const r = await getRecord(id);
    expect([r?.outputs.minutes?.text, r?.outputs.summary?.text, r?.outputs.todos]).toEqual(['minutes-out', 'summary-out', undefined]);
    expect(r?.stages.outputs.todos).toMatchObject({ status: 'error', error: '利用上限に達しました' });
    expect(vi.mocked(api.generate).mock.calls[0]![1]).toBe('確認済み本文');
  });

  it('再起動で running のまま残った段階を整理する（ジョブID付きの文字起こしは再開可能に）', async () => {
    const id = await newRec();
    const rec = (await getRecord(id))!;
    await putRecord({ ...rec, jobId: 'j', stages: { ...rec.stages, transcribe: { status: 'running' }, polish: { status: 'running' } } });
    await recoverStaleStages([(await getRecord(id))!]);
    const r = await getRecord(id);
    expect(r?.stages.transcribe.status).toBe('idle');
    expect(r?.stages.polish).toMatchObject({ status: 'error' });
  });
});
