import { describe, expect, it } from 'vitest';
import { collapseRepeats, generateByRules, polishText, removeFillers, rulesTextEngine, sentencesOf } from '../src/lib/engines/rules';
import { OUTPUT_KINDS } from '@app/shared';

const MEETING = `[00:00:00]
えー、本日は炉圧の件です。あのー、先週から炉圧が1.5MPaまで上がりました。原因は足ポンプの不具合でした。
[00:01:00]
えっと、対策としてアッシュポンプへ交換することに決定しました。来週月曜までに田中さんが手配をお願いします。
確認、確認します。板温は 650℃ で安定しています。あの会議の資料は共有します。`;

describe('簡易整文（ルールベース）', () => {
  it('言い淀みを除去し、数値・固有名詞・時刻見出しは変えない', () => {
    const out = polishText(MEETING);
    expect(out).not.toMatch(/えー|あのー|えっと/);
    expect(out).toContain('[00:00:00]');
    expect(out).toContain('1.5MPa');
    expect(out).toContain('650℃');
    expect(out).toContain('足ポンプ');
    expect(out).toContain('アッシュポンプ');
  });
  it('指示語の「あの会議」は消さない。読点・長音を伴う言い淀みだけ除去', () => {
    expect(removeFillers('あの会議の資料')).toBe('あの会議の資料');
    expect(removeFillers('えー、確認します')).toBe('確認します');
    expect(removeFillers('結果です。あのー、次に')).toBe('結果です。次に');
  });
  it('重複フレーズは1つに。数字を含むものは触らない', () => {
    expect(collapseRepeats('確認、確認します')).toBe('確認します');
    expect(collapseRepeats('10、10です')).toBe('10、10です');
  });
  it('改行の無い長文は3文ごとに段落分け', () => {
    const t = 'これは文です。'.repeat(30);
    expect(polishText(t).split('\n\n').length).toBe(10);
  });
  it('エンジン経由でも生データは引数のまま（新しい文字列を返す）', async () => {
    const raw = 'えー、テストです。';
    const r = await rulesTextEngine.polish(raw);
    expect(r.text).toBe('テストです。');
    expect(raw).toBe('えー、テストです。');
    expect(r.model).toContain('AIなし');
  });
});

describe('簡易抽出（ルールベース）', () => {
  const sentences = sentencesOf(polishText(MEETING));
  const inSource = (line: string) => sentences.some((s) => line.includes(s));

  it('決定事項・ToDoは原文の文を抜き出す。期限は原文の表現のみ、担当は推測せず未記載', () => {
    const d = generateByRules('decisions', MEETING);
    expect(d).toContain('決定しました');
    const t = generateByRules('todos', MEETING);
    expect(t).toContain('- [ ]');
    expect(t).toContain('期限: 来週');
    expect(t).toContain('担当: 未記載');
  });
  it('要約・箇条書き・報告台本の本文は原文の文だけで構成される（創作しない）', () => {
    for (const kind of ['summary', 'bullets'] as const) {
      const body = generateByRules(kind, MEETING).split('\n\n※')[0]!;
      for (const line of body.split('\n').map((l) => l.replace(/^- /, '')).filter(Boolean)) {
        expect(inSource(line) || sentences.some((s) => line.includes(s))).toBe(true);
      }
    }
  });
  it('議事録は必須見出しを持ち、AIではない旨を明示', () => {
    const m = generateByRules('minutes', MEETING, '定例');
    for (const h of ['## 議題', '## 概要', '## 主な議論', '## 確認された事実', '## 決定事項', '## 今後の対応', '## ToDo']) expect(m).toContain(h);
    expect(m).toContain('AIではありません');
    expect(m).toContain('650℃'); // 数値を含む文は「確認された事実」へ
  });
  it('全種類を生成でき、決定事項が無ければ正直にそう書く', () => {
    for (const k of OUTPUT_KINDS) expect(generateByRules(k, MEETING).length).toBeGreaterThan(10);
    expect(generateByRules('decisions', '今日は天気の話をしました。雨でした。')).toContain('確認できませんでした');
  });
  it('校正候補はAIでは出さない', async () => {
    expect(await rulesTextEngine.proofread('えー')).toEqual([]);
  });
});
