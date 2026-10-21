import type { OutputKind } from '@app/shared';
import type { GeneratedPiece, TextEngine } from './types';

/**
 * AIを使わない簡易処理（無料・端末内）。入力に無い内容は作らず、原文の文を抜き出す/整えるだけ。
 * 数値・固有名詞は変更しない。
 */
export const RULES_MODEL = 'ルールベース（AIなし）';
const NOTE = '※ルールベースの簡易版です（AIではありません）。重要事項は必ず原文で確認してください。';

const TS_LINE = /^\[\d{2}:\d{2}:\d{2}\]$/;

/** 言い淀み除去。「あの会議」のような指示語は残すため、読点または長音を伴うものだけ対象にする。 */
export function removeFillers(line: string): string {
  return line
    .replace(/(?<=^|[、。！？\s])(?:えーっと|えーと|えっと|ええと|えー|うーん|あのー+|そのー+)[、,]?/gm, '')
    .replace(/(?<=^|[、。！？\s])(?:あのですね|まあ|あの)[、,]/gm, '')
    .replace(/^[、,\s]+/, '');
}

/** 直前と同じ短いフレーズの繰り返し（「確認、確認」）を1つにする。数字を含むものは触らない。 */
export function collapseRepeats(line: string): string {
  // 後続が助詞・句読点・語尾のときだけ（「確認、確認書」のような別語を壊さない）
  return line.replace(/([^\s、,。]{2,12})[、,]\s*\1(?=[をはがにでもとのへ、,。！？]|します|する|しました|です|ます|でした|$)/g, (m, p: string) => (/\d/.test(p) ? m : p));
}

export function polishText(text: string): string {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || TS_LINE.test(line)) {
      out.push(line);
      continue;
    }
    out.push(collapseRepeats(removeFillers(line)).replace(/[ \t]{2,}/g, ' ').trim());
  }
  const joined = out.join('\n').replace(/\n{3,}/g, '\n\n');
  // 改行が全く無い長文は、3文ごとに段落を分けて読みやすくする
  if (!joined.includes('\n') && joined.length > 120) {
    const sentences = joined.split(/(?<=[。！？])/).filter(Boolean);
    const paras: string[] = [];
    for (let i = 0; i < sentences.length; i += 3) paras.push(sentences.slice(i, i + 3).join(''));
    return paras.join('\n\n');
  }
  return joined;
}

export function sentencesOf(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => !TS_LINE.test(l.trim()))
    .join('\n')
    .split(/(?<=[。！？])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4);
}

const IMPORTANT = /(決定|課題|問題|原因|対策|変更|確認|必要|期限|予定|目標|結果|報告|不具合|改善|方針|異常|停止|再開|実施)/g;
const DECISION = /(決定|決まり|決めた|決めました|ことになり|ことにな[るっ]|で進める|で行く|採用|承認|合意|方針)/;
const TODO = /(お願い|対応します|対応する|確認します|確認する|依頼|やっておき|実施します|実施する|検討します|検討する|報告します|連絡します|共有します|手配|進めます|までに)/;
const FACT = /\d[\d.,]*\s*(?:%|％|℃|度|mm|ｍｍ|kg|t|トン|MPa|Pa|m|分|秒|時間|個|本|枚|件|回|円)/;
const DEADLINE = /(\d{1,2}月\d{1,2}日|\d{1,2}日|今日|明日|明後日|今週|来週|再来週|今月|来月|月曜|火曜|水曜|木曜|金曜|\d{1,2}時|\d{1,2}月末|週明け)/;

function score(s: string): number {
  const hits = (s.match(IMPORTANT) ?? []).length;
  const num = FACT.test(s) ? 1 : 0;
  const len = s.length >= 15 && s.length <= 90 ? 1 : 0;
  return hits * 2 + num + len;
}

function top(sentences: string[], n: number): string[] {
  const ranked = sentences.map((s, i) => ({ s, i, sc: score(s) })).sort((a, b) => b.sc - a.sc || a.i - b.i).slice(0, n);
  return ranked.sort((a, b) => a.i - b.i).map((x) => x.s);
}

const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');
const none = '（該当する記述を検出できませんでした）';

function todoLines(sentences: string[]): string[] {
  return sentences.filter((s) => TODO.test(s)).slice(0, 12).map((s) => {
    const due = DEADLINE.exec(s)?.[1];
    return `- [ ] ${s}（担当: 未記載 / 期限: ${due ?? '未記載'}）`;
  });
}

function summaryOf(sentences: string[]): string {
  if (sentences.length === 0) return '';
  const picks = [...new Set([sentences[0]!, ...top(sentences.slice(1), 3)])];
  return picks.join('');
}

export function generateByRules(kind: OutputKind, text: string, title?: string): string {
  const sentences = sentencesOf(polishText(text));
  const decisions = sentences.filter((s) => DECISION.test(s)).slice(0, 10);
  const todos = todoLines(sentences);
  switch (kind) {
    case 'summary':
      return `${summaryOf(sentences) || none}\n\n${NOTE}`;
    case 'bullets':
      return `${sentences.length ? bullets(top(sentences, 8)) : none}\n\n${NOTE}`;
    case 'decisions':
      return `${decisions.length ? bullets(decisions) : '決定事項は確認できませんでした（簡易抽出）'}\n\n${NOTE}`;
    case 'todos':
      return `${todos.length ? todos.join('\n') : none}\n\n${NOTE}`;
    case 'script': {
      const parts = ['ご報告します。', summaryOf(sentences)];
      if (decisions.length) parts.push(`\n決まったこととして、${decisions.slice(0, 3).join('')}`);
      if (todos.length) parts.push(`\n今後の対応として、${sentences.filter((s) => TODO.test(s)).slice(0, 3).join('')}`);
      parts.push('\n以上です。');
      return `${parts.join('')}\n\n${NOTE}`;
    }
    case 'minutes':
      return [
        `# ${title || '議事録'}`,
        '',
        NOTE,
        '',
        '## 議題',
        '（記載なし：ルールベースでは議題を判定できません）',
        '',
        '## 概要',
        summaryOf(sentences) || none,
        '',
        '## 主な議論',
        sentences.length ? bullets(top(sentences, 8)) : none,
        '',
        '## 確認された事実',
        bullets(sentences.filter((s) => FACT.test(s)).slice(0, 8)) || none,
        '',
        '## 決定事項',
        decisions.length ? bullets(decisions) : '（確認できませんでした）',
        '',
        '## 今後の対応',
        sentences.filter((s) => TODO.test(s)).slice(0, 8).map((s) => `- ${s}`).join('\n') || none,
        '',
        '## ToDo',
        todos.length ? todos.join('\n') : none,
      ].join('\n');
  }
}

export const rulesTextEngine: TextEngine = {
  id: 'rules',
  // 校正候補は辞書（pipeline側で常に追加）のみ。AIによる推測は行わない
  async proofread() {
    return [];
  },
  async polish(text): Promise<GeneratedPiece> {
    return { text: polishText(text), model: RULES_MODEL };
  },
  async generate(kind, text, title): Promise<GeneratedPiece> {
    return { text: generateByRules(kind, text, title), model: RULES_MODEL };
  },
};
