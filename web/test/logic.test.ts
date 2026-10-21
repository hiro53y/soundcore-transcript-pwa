import { describe, expect, it } from 'vitest';
import { applyCorrections, countOccurrences, decide, mergeCandidates, pendingCount } from '../src/lib/corrections';
import { dictionaryCandidates, normalizeMisrecognitions, toDictionaryContext } from '../src/lib/dictionary';
import { diffStats, diffText } from '../src/lib/diff';
import { recordToMarkdown, safeFileName } from '../src/lib/exporter';
import { formatBytes, formatDuration } from '../src/lib/format';
import { newRecord } from '../src/lib/importFile';
import type { DictionaryEntry } from '../src/lib/types';

const dict: DictionaryEntry[] = [
  { id: '1', term: 'CGL', misrecognitions: ['シージーエル', 'CGLL'] },
  { id: '2', term: 'アッシュポンプ', misrecognitions: [] },
  { id: '3', term: '  ', misrecognitions: ['x'] },
];

describe('専門用語辞書', () => {
  it('APIへ渡す文脈は空の用語を除き、ID/メモを含まない', () => {
    const ctx = toDictionaryContext(dict);
    expect(ctx?.terms).toEqual([
      { term: 'CGL', misrecognitions: ['シージーエル', 'CGLL'] },
      { term: 'アッシュポンプ', misrecognitions: [] },
    ]);
    expect(JSON.stringify(ctx)).not.toContain('"id"');
    expect(toDictionaryContext([])).toBeUndefined();
  });
  it('誤認識の置換候補を本文に実在するものだけ作る（自動置換はしない）', () => {
    const text = 'シージーエルの板温を確認した。シージーエルは正常。';
    const c = dictionaryCandidates(text, dict, () => 'id');
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ original: 'シージーエル', suggestion: 'CGL', source: 'dictionary', confidence: 'high' });
    expect(text).toContain('シージーエル'); // 本文は不変
  });
  it('入力の区切りを正規化', () => {
    expect(normalizeMisrecognitions('シージーエル、 CGLL,シージーエル\n')).toEqual(['シージーエル', 'CGLL']);
  });
});

describe('文字起こし修正', () => {
  const raw = '足ポンプを機械式に変更した。足ポンプの点検は来週。';
  const base = { id: 'c1', original: '足ポンプ', suggestion: 'アッシュポンプ', reason: 'r', confidence: 'medium' as const, source: 'ai' as const, decision: 'pending' as const };
  it('未判断・却下では本文は変わらない', () => {
    expect(applyCorrections(raw, [base])).toBe(raw);
    expect(applyCorrections(raw, decide([base], 'c1', 'rejected'))).toBe(raw);
  });
  it('採用で置換、自分で修正なら入力表記で置換。生文字列は不変', () => {
    expect(applyCorrections(raw, decide([base], 'c1', 'accepted'))).toBe('アッシュポンプを機械式に変更した。アッシュポンプの点検は来週。');
    expect(applyCorrections(raw, decide([base], 'c1', 'edited', 'ASHポンプ'))).toBe('ASHポンプを機械式に変更した。ASHポンプの点検は来週。');
    expect(raw).toBe('足ポンプを機械式に変更した。足ポンプの点検は来週。');
  });
  it('採用を取り消すと元に戻る', () => {
    const accepted = decide([base], 'c1', 'accepted');
    expect(applyCorrections(raw, decide(accepted, 'c1', 'pending'))).toBe(raw);
  });
  it('候補の統合は既存の判断を保持し重複を足さない', () => {
    const merged = mergeCandidates(decide([base], 'c1', 'accepted'), [
      { id: 'n1', original: '足ポンプ', suggestion: 'アッシュポンプ', reason: '', confidence: 'low', source: 'dictionary' },
      { id: 'n2', original: '炉圧', suggestion: '炉圧力', reason: '', confidence: 'low', source: 'ai' },
    ]);
    expect(merged.map((c) => [c.original, c.decision])).toEqual([['足ポンプ', 'accepted'], ['炉圧', 'pending']]);
    expect(pendingCount(merged)).toBe(1);
  });
  it('出現数', () => expect(countOccurrences(raw, '足ポンプ')).toBe(2));
});

describe('差分表示', () => {
  it('追加・削除を語単位で表す', () => {
    const parts = diffText('えー、足ポンプを変更した', '足ポンプを変更した');
    expect(parts.some((p) => p.kind === 'del' && p.text.includes('えー'))).toBe(true);
    expect(parts.filter((p) => p.kind === 'add')).toHaveLength(0);
    expect(diffStats(parts).removed).toBeGreaterThan(0);
  });
  it('同一テキストは差分なし', () => {
    expect(diffText('同じ', '同じ')).toEqual([{ kind: 'same', text: '同じ' }]);
  });
  it('再構成すると元の文字列と一致する', () => {
    const a = '炉圧が高い。板温は正常。';
    const b = '炉圧が高めである。板温は正常だった。';
    const parts = diffText(a, b);
    expect(parts.filter((p) => p.kind !== 'add').map((p) => p.text).join('')).toBe(a);
    expect(parts.filter((p) => p.kind !== 'del').map((p) => p.text).join('')).toBe(b);
  });
});

describe('エクスポート整形', () => {
  it('Markdownは生/確認済み/整文/AI生成を別見出しで区別する', () => {
    const r = newRecord({ id: '1', fileName: 'a.mp3', fileSize: 1, fingerprint: 'f', source: 'picker', now: '2026-10-01T00:00:00Z' });
    r.rawTranscript = 'RAW';
    r.confirmedTranscript = 'CONFIRMED';
    r.polished = { text: 'POLISHED', model: 'm', createdAt: 'x' };
    r.outputs.minutes = { text: 'MINUTES', model: 'm', createdAt: 'x' };
    const md = recordToMarkdown(r);
    for (const h of ['## 議事録（AI生成）', '## 整文（AI整文）', '## 確認済み文字起こし', '## 生文字起こし（音声認識の出力）']) expect(md).toContain(h);
    expect(md.indexOf('RAW')).toBeGreaterThan(md.indexOf('CONFIRMED'));
  });
  it('ファイル名の禁止文字を除く', () => expect(safeFileName('a/b:c*?.txt')).toBe('a_b_c__.txt'));
  it('表示整形', () => {
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatDuration(3725)).toBe('1時間2分5秒');
    expect(formatDuration(undefined)).toBe('不明');
  });
});
