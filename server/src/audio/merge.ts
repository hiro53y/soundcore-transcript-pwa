import { formatClock } from '@app/shared';

export interface ChunkText {
  startSec: number;
  text: string;
  overlapsPrevious: boolean;
}

const MIN_OVERLAP = 6;
const MAX_OVERLAP = 300;

/** prev の末尾と next の先頭が一致する最長部分（空白無視）を next から削る。強制分割オーバーラップ専用。 */
export function dedupeBoundary(prev: string, next: string): string {
  const strip = (s: string) => s.replace(/\s+/g, '');
  const a = strip(prev).slice(-MAX_OVERLAP);
  const nextChars = [...next];
  // next の先頭 k 文字(空白除く)が a の末尾と一致する最大 k を探す
  let nonSpaceIdx: number[] = [];
  nextChars.forEach((c, i) => {
    if (!/\s/.test(c)) nonSpaceIdx.push(i);
  });
  nonSpaceIdx = nonSpaceIdx.slice(0, MAX_OVERLAP);
  const nextStripped = nonSpaceIdx.map((i) => nextChars[i]).join('');
  for (let k = Math.min(a.length, nextStripped.length); k >= MIN_OVERLAP; k--) {
    if (a.endsWith(nextStripped.slice(0, k))) {
      const cutAt = (nonSpaceIdx[k - 1] ?? -1) + 1;
      return nextChars.slice(cutAt).join('').replace(/^\s+/, '');
    }
  }
  return next;
}

/**
 * チャンクを順序通りに結合する。複数チャンクの場合は区間開始時刻の見出し `[hh:mm:ss]` を付ける。
 * タイムスタンプは区間単位（単語単位ではない）。
 */
export function mergeChunks(chunks: ChunkText[]): string {
  const sorted = [...chunks].sort((a, b) => a.startSec - b.startSec);
  if (sorted.length === 1) return (sorted[0]?.text ?? '').trim();
  const parts: string[] = [];
  let prevText = '';
  for (const c of sorted) {
    let t = c.text.trim();
    if (c.overlapsPrevious && prevText) t = dedupeBoundary(prevText, t);
    prevText = c.text.trim();
    if (!t) continue;
    parts.push(`[${formatClock(c.startSec)}]\n${t}`);
  }
  return parts.join('\n\n');
}
