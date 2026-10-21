// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { getRecord, patchSettings, putRecord } from '../src/lib/db';
import { newRecord } from '../src/lib/importFile';
import { RecordScreen } from '../src/screens/Record';

afterEach(cleanup);

describe('文字起こし確認UI', () => {
  it('採用で差分が出て、確認済みにしても生文字起こしは変わらない', async () => {
    const r = newRecord({ id: 'r1', fileName: 'a.mp3', fileSize: 10, fingerprint: 'f', source: 'picker', now: '2026-10-01T00:00:00Z' });
    r.stages.transcribe = { status: 'done' };
    r.rawTranscript = '足ポンプを機械式に変更した';
    r.corrections = [{ id: 'c1', original: '足ポンプ', suggestion: 'アッシュポンプ', reason: '設備名として自然', confidence: 'medium', source: 'ai', decision: 'pending' }];
    await putRecord(r);

    render(<RecordScreen id="r1" />);
    await screen.findByText('原文');
    expect(screen.getByText('確信度: 中')).toBeTruthy();
    expect(screen.getByText('設備名として自然')).toBeTruthy();
    expect(screen.getByRole('button', { name: '採用' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '却下' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '自分で修正' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '採用' }));
    await screen.findByText(/採用済み/);
    await waitFor(() => expect(screen.getByTestId('diff').querySelector('ins')?.textContent).toBe('アッシュポンプ'));

    fireEvent.click(screen.getByRole('button', { name: /確認済みにする/ }));
    await waitFor(async () => expect((await getRecord('r1'))?.confirmedTranscript).toBe('アッシュポンプを機械式に変更した'));
    expect((await getRecord('r1'))?.rawTranscript).toBe('足ポンプを機械式に変更した');
  });

  it('却下すると本文は変わらず、自分で修正すると入力した表記で確定する', async () => {
    const r = newRecord({ id: 'r2', fileName: 'a.mp3', fileSize: 10, fingerprint: 'f2', source: 'picker', now: '2026-10-01T00:00:00Z' });
    r.stages.transcribe = { status: 'done' };
    r.rawTranscript = '炉圧と板温を確認';
    r.corrections = [
      { id: 'a', original: '炉圧', suggestion: '炉圧力', reason: '', confidence: 'low', source: 'ai', decision: 'pending' },
      { id: 'b', original: '板温', suggestion: '板厚', reason: '', confidence: 'low', source: 'ai', decision: 'pending' },
    ];
    await putRecord(r);
    render(<RecordScreen id="r2" />);
    await screen.findAllByRole('button', { name: '却下' });
    fireEvent.click(screen.getAllByRole('button', { name: '却下' })[0]!);
    await screen.findByText(/却下済み/);
    fireEvent.click(screen.getAllByRole('button', { name: '自分で修正' })[0]!);
    fireEvent.change(screen.getByLabelText('修正後の表記'), { target: { value: '板温度' } });
    fireEvent.click(screen.getByRole('button', { name: 'この表記で採用' }));
    await screen.findByText(/修正して採用/);
    fireEvent.click(screen.getByRole('button', { name: /確認済みにする/ }));
    await waitFor(async () => expect((await getRecord('r2'))?.confirmedTranscript).toBe('炉圧と板温度を確認'));
  });

  it('確認画面では「文字起こしを開始」を押すまで開始されない。既定（端末内）は外部送信なしと表示し、初回DLの目安も出す', async () => {
    const r = newRecord({ id: 'r3', fileName: 'meeting.mp3', fileSize: 2048, durationSec: 125, fingerprint: 'f3', source: 'share', now: '2026-10-01T00:00:00Z' });
    await putRecord(r);
    render(<RecordScreen id="r3" />);
    await screen.findByText('meeting.mp3');
    expect(screen.getByText('2.0 KB')).toBeTruthy();
    expect(screen.getByText('2分5秒')).toBeTruthy();
    await screen.findByText(/外部へ送信されません/);
    await screen.findByText(/初回のみ、モデル/);
    expect(screen.getByRole('button', { name: '文字起こしを開始' })).toBeTruthy();
    expect((await getRecord('r3'))?.stages.transcribe.status).toBe('idle');
  });

  it('Gemini選択時は外部送信と無料枠の学習利用の注意を表示し、キー未設定なら開始できない', async () => {
    await patchSettings({ transcribeEngine: 'gemini' });
    const r = newRecord({ id: 'r4', fileName: 'm.mp3', fileSize: 2048, durationSec: 60, fingerprint: 'f4', source: 'share', now: '2026-10-01T00:00:00Z' });
    await putRecord(r);
    render(<RecordScreen id="r4" />);
    await screen.findByText(/製品改善に使われる場合があります/);
    await screen.findByText(/APIキーを入力してください/);
    expect((screen.getByRole('button', { name: '文字起こしを開始' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('端末内方式で45分を超える音声は、開始前に理由と対処を表示する', async () => {
    const r = newRecord({ id: 'r5', fileName: 'long.mp3', fileSize: 2048, durationSec: 60 * 60, fingerprint: 'f5', source: 'share', now: '2026-10-01T00:00:00Z' });
    await putRecord(r);
    render(<RecordScreen id="r5" />);
    await screen.findByText(/上限（45分）を超えています/);
    expect((screen.getByRole('button', { name: '文字起こしを開始' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
