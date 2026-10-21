import { diffArrays } from 'diff';

export interface DiffPart {
  kind: 'same' | 'add' | 'del';
  text: string;
}

function tokenize(s: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter('ja', { granularity: 'word' });
    return [...seg.segment(s)].map((x) => x.segment);
  }
  return s.match(/[A-Za-z0-9_]+|\s+|[\s\S]/g) ?? [];
}

/** 日本語の語単位（Intl.Segmenter）で差分を取り、同種の隣接部分をまとめる。 */
export function diffText(a: string, b: string): DiffPart[] {
  if (a === b) return a ? [{ kind: 'same', text: a }] : [];
  const parts = diffArrays(tokenize(a), tokenize(b));
  const out: DiffPart[] = [];
  for (const p of parts) {
    const kind = p.added ? 'add' : p.removed ? 'del' : 'same';
    const text = p.value.join('');
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  }
  return out;
}

export function diffStats(parts: DiffPart[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const p of parts) {
    if (p.kind === 'add') added += p.text.length;
    if (p.kind === 'del') removed += p.text.length;
  }
  return { added, removed };
}
