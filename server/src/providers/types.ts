import type { DictionaryContext } from '@app/shared';

export interface TranscribeOptions {
  chunkIndex: number;
  language?: string;
  dictionary?: DictionaryContext;
  signal?: AbortSignal;
}

/** 文字起こしProvider。差し替え可能（OpenAI / mock / 将来の他社）。 */
export interface TranscriptionProvider {
  readonly name: string;
  readonly model: string;
  /** 25MB以下の音声ファイル1本を文字起こしする。 */
  transcribe(filePath: string, opt: TranscribeOptions): Promise<{ text: string }>;
}

export type LlmTask = 'proofread' | 'polish' | 'minutes' | 'summary' | 'bullets' | 'decisions' | 'todos' | 'script';

export interface LlmTextRequest {
  task: LlmTask;
  model: string;
  instructions: string;
  input: string;
  signal?: AbortSignal;
}
export interface LlmJsonRequest extends LlmTextRequest {
  schemaName: string;
  schema: Record<string, unknown>;
}

/** 整文・校正・議事録生成Provider。 */
export interface LlmProvider {
  readonly name: string;
  generateText(req: LlmTextRequest): Promise<string>;
  generateJson(req: LlmJsonRequest): Promise<unknown>;
}
