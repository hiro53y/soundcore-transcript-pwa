import type { Correction, CorrectionCandidate } from '@app/shared';

export function toPending(c: CorrectionCandidate): Correction {
  return { ...c, decision: 'pending' };
}

/** 既存の判断を保ったまま、新しい候補を追加する（同じ original→suggestion は重複させない）。 */
export function mergeCandidates(existing: Correction[], incoming: CorrectionCandidate[]): Correction[] {
  const keys = new Set(existing.map((c) => `${c.original}\u0000${c.suggestion}`));
  const added = incoming.filter((c) => !keys.has(`${c.original}\u0000${c.suggestion}`)).map(toPending);
  return [...existing, ...added];
}

export function countOccurrences(text: string, needle: string): number {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

/**
 * 採用/手修正された訂正だけを生文字起こしに適用する。生データ自体は変更しない（新しい文字列を返す）。
 * 却下・未判断の候補は何も変えない。
 */
export function applyCorrections(raw: string, corrections: Correction[]): string {
  let text = raw;
  for (const c of corrections) {
    const replacement = c.decision === 'accepted' ? c.suggestion : c.decision === 'edited' ? c.finalText : undefined;
    if (replacement === undefined || replacement === c.original || !c.original) continue;
    text = text.split(c.original).join(replacement);
  }
  return text;
}

export function decide(list: Correction[], id: string, decision: Correction['decision'], finalText?: string): Correction[] {
  return list.map((c) => (c.id === id ? { ...c, decision, finalText: decision === 'edited' ? finalText : undefined } : c));
}

export function pendingCount(list: Correction[]): number {
  return list.filter((c) => c.decision === 'pending').length;
}
