import type { CorrectionCandidate, DictionaryContext } from '@app/shared';
import type { DictionaryEntry } from './types';

/** サーバー/LLMへ渡す辞書。IDやメモ等の不要情報は含めない。 */
export function toDictionaryContext(entries: DictionaryEntry[]): DictionaryContext | undefined {
  const terms = entries
    .filter((e) => e.term.trim())
    .map((e) => ({ term: e.term.trim(), misrecognitions: e.misrecognitions.map((m) => m.trim()).filter(Boolean) }));
  return terms.length ? { terms } : undefined;
}

/** 「誤認識 → 正式表記」の辞書から、本文に実在する置換候補を作る（確定はユーザー）。 */
export function dictionaryCandidates(text: string, entries: DictionaryEntry[], newId: () => string = () => crypto.randomUUID()): CorrectionCandidate[] {
  const out: CorrectionCandidate[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    for (const mis of e.misrecognitions) {
      const m = mis.trim();
      if (!m || m === e.term || !text.includes(m)) continue;
      const k = `${m}\u0000${e.term}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({
        id: newId(),
        original: m,
        suggestion: e.term,
        reason: `辞書: 「${m}」は「${e.term}」の誤認識として登録されています`,
        confidence: 'high',
        source: 'dictionary',
      });
    }
  }
  return out;
}

export function normalizeMisrecognitions(input: string): string[] {
  return [...new Set(input.split(/[,、\n]/).map((s) => s.trim()).filter(Boolean))];
}
