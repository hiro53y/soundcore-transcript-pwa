import { randomUUID } from 'node:crypto';
import type { CorrectionCandidate, DictionaryContext, OutputKind, TextResponse } from '@app/shared';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import type { LlmProvider } from '../providers/types.js';
import { PROOFREAD_SCHEMA, generateInstructions, polishInstructions, proofreadInstructions } from './prompts.js';

const POLISH_CHUNK = 6000;
const PROOFREAD_CHUNK = 8000;

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

const CONF = new Set(['high', 'medium', 'low']);

/** LLM出力を検証し、本文に存在しない original（幻覚）や無意味な候補を捨てる。 */
export function sanitizeCandidates(raw: unknown, text: string): CorrectionCandidate[] {
  const list = (raw as { candidates?: unknown })?.candidates;
  if (!Array.isArray(list)) throw new AppError('provider_error', 'AIの校正結果の形式が不正です。');
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
      id: randomUUID(),
      original,
      suggestion,
      reason: typeof o.reason === 'string' ? o.reason : '',
      confidence: CONF.has(String(o.confidence)) ? (o.confidence as 'high' | 'medium' | 'low') : 'low',
      source: 'ai',
    });
  }
  return out;
}

export class LlmService {
  constructor(
    private readonly provider: LlmProvider,
    private readonly cfg: Config,
  ) {}

  async proofread(text: string, dict?: DictionaryContext): Promise<CorrectionCandidate[]> {
    const all: CorrectionCandidate[] = [];
    const seen = new Set<string>();
    for (const part of splitForLlm(text, PROOFREAD_CHUNK)) {
      const raw = await this.provider.generateJson({
        task: 'proofread',
        model: this.cfg.llmModel,
        instructions: proofreadInstructions(dict),
        input: part,
        schemaName: 'proofread_candidates',
        schema: PROOFREAD_SCHEMA as unknown as Record<string, unknown>,
      });
      for (const c of sanitizeCandidates(raw, part)) {
        const k = `${c.original}\u0000${c.suggestion}`;
        if (seen.has(k)) continue;
        seen.add(k);
        all.push(c);
      }
    }
    return all;
  }

  async polish(text: string, dict?: DictionaryContext): Promise<TextResponse> {
    const parts: string[] = [];
    for (const part of splitForLlm(text, POLISH_CHUNK)) {
      parts.push(
        (
          await this.provider.generateText({
            task: 'polish',
            model: this.cfg.llmModel,
            instructions: polishInstructions(dict),
            input: part,
          })
        ).trim(),
      );
    }
    return { text: parts.join('\n\n'), model: this.cfg.llmModel };
  }

  async generate(kind: OutputKind, text: string, title?: string, dict?: DictionaryContext): Promise<TextResponse> {
    // 議事録のみ主モデル、他は軽量モデル
    const model = kind === 'minutes' || kind === 'script' ? this.cfg.llmModel : this.cfg.llmModelLight;
    const out = await this.provider.generateText({
      task: kind,
      model,
      instructions: generateInstructions(kind, title, dict),
      input: text,
    });
    return { text: out.trim(), model };
  }
}
