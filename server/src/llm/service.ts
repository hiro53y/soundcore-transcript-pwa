import type { CorrectionCandidate, DictionaryContext, OutputKind, TextResponse } from '@app/shared';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import type { LlmProvider } from '../providers/types.js';
import {
  InvalidCandidatesError,
  POLISH_CHUNK,
  PROOFREAD_CHUNK,
  PROOFREAD_SCHEMA,
  generateInstructions,
  polishInstructions,
  proofreadInstructions,
  sanitizeCandidates as sharedSanitize,
  splitForLlm,
} from '@app/shared';

/** LLM出力を検証し、不正な形式は AppError にする（共通ロジックは shared）。 */
export function sanitizeCandidates(raw: unknown, text: string): CorrectionCandidate[] {
  try {
    return sharedSanitize(raw, text);
  } catch (e) {
    if (e instanceof InvalidCandidatesError) throw new AppError('provider_error', 'AIの校正結果の形式が不正です。');
    throw e;
  }
}

export { splitForLlm };

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
