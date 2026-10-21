import type { LlmJsonRequest, LlmProvider, LlmTextRequest, TranscribeOptions, TranscriptionProvider } from './types.js';

/** 外部通信なしのデモ・E2E用Provider。 */
export class MockTranscriptionProvider implements TranscriptionProvider {
  readonly name = 'mock';
  readonly model = 'mock-transcribe';
  constructor(private readonly delayMs = 0) {}
  async transcribe(_file: string, opt: TranscribeOptions): Promise<{ text: string }> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    return {
      text: `これはモックの文字起こしです。区間${opt.chunkIndex + 1}。えー、足ポンプを機械式に変更した。シージーエルの板温を確認しました。`,
    };
  }
}

export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';
  async generateText(req: LlmTextRequest): Promise<string> {
    if (req.task === 'polish') return req.input.replace(/えー、|あのー、?/g, '');
    return `【モック:${req.task}】\n${req.input.slice(0, 200)}`;
  }
  async generateJson(req: LlmJsonRequest): Promise<unknown> {
    const candidates: unknown[] = [];
    if (req.input.includes('足ポンプ')) {
      candidates.push({ original: '足ポンプ', suggestion: 'アッシュポンプ', reason: '設備名として文脈上自然（モック）', confidence: 'medium' });
    }
    return { candidates };
  }
}
