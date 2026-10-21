import type { CorrectionCandidate } from './index';

export const POLISH_CHUNK = 6000;
export const PROOFREAD_CHUNK = 8000;

/** 段落境界を優先して、最大 max 文字ずつに分ける。 */
export function splitForLlm(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  for (const para of text.split(/\n{2,}/)) {
    if (cur && cur.length + para.length + 2 > max) {
      out.push(cur);
      cur = '';
    }
    if (para.length > max) {
      // 長い段落は句点で再分割
      for (const s of para.split(/(?<=[。！？\n])/)) {
        if (cur && cur.length + s.length > max) {
          out.push(cur);
          cur = '';
        }
        cur += s;
      }
    } else {
      cur += (cur ? '\n\n' : '') + para;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export class InvalidCandidatesError extends Error {
  constructor() {
    super('校正結果の形式が不正です');
    this.name = 'InvalidCandidatesError';
  }
}

const CONF = new Set(['high', 'medium', 'low']);

/** LLM出力を検証し、本文に存在しない original（幻覚）や無意味な候補を捨てる。 */
export function sanitizeCandidates(raw: unknown, text: string, newId: () => string = () => (globalThis as unknown as { crypto: { randomUUID(): string } }).crypto.randomUUID()): CorrectionCandidate[] {
  const list = (raw as { candidates?: unknown })?.candidates;
  if (!Array.isArray(list)) throw new InvalidCandidatesError();
  const seen = new Set<string>();
  const out: CorrectionCandidate[] = [];
  for (const c of list) {
    const o = c as Record<string, unknown>;
    if (typeof o.original !== 'string' || typeof o.suggestion !== 'string') continue;
    const original = o.original.trim();
    const suggestion = o.suggestion.trim();
    if (!original || !suggestion || original === suggestion) continue;
    if (!text.includes(original)) continue;
    const key = `${original}\u0000${suggestion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: newId(),
      original,
      suggestion,
      reason: typeof o.reason === 'string' ? o.reason : '',
      confidence: CONF.has(String(o.confidence)) ? (o.confidence as 'high' | 'medium' | 'low') : 'low',
      source: 'ai',
    });
  }
  return out;
}
