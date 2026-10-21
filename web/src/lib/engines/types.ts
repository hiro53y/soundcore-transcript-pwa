import type { CorrectionCandidate, DictionaryContext, OutputKind } from '@app/shared';

export type TranscribeEngineId = 'local' | 'gemini' | 'server';
export type TextEngineId = 'rules' | 'gemini' | 'server';

export interface EngineProgress {
  label: string;
  ratio?: number;
  /** 区間数の進捗（表示用に保存する）。 */
  chunks?: { done: number; total: number };
}

export interface TranscribeInput {
  recordId: string;
  /** 端末内に音声がある場合。server エンジンはジョブ再開時のみ省略可。 */
  blob?: Blob;
  durationSec?: number;
  dictionary?: DictionaryContext;
  /** server エンジンの再開用ジョブID。 */
  resumeJobId?: string;
  onProgress: (p: EngineProgress) => void;
  /** server エンジンがジョブ作成時に呼ぶ（再開のため保存する）。 */
  onJob?: (jobId: string) => void;
  pollMs?: number;
}

export interface TranscribeEngine {
  readonly id: TranscribeEngineId;
  /** 事前チェック。問題があれば利用者向けメッセージを返す（送信・処理を始めない）。 */
  preflight?(input: { durationSec?: number; size?: number }): string | undefined;
  transcribe(input: TranscribeInput): Promise<string>;
}

export interface GeneratedPiece {
  text: string;
  model: string;
}

export interface TextEngine {
  readonly id: TextEngineId;
  proofread(text: string, dictionary?: DictionaryContext): Promise<CorrectionCandidate[]>;
  polish(text: string, dictionary?: DictionaryContext): Promise<GeneratedPiece>;
  generate(kind: OutputKind, text: string, title?: string, dictionary?: DictionaryContext): Promise<GeneratedPiece>;
}

/** 利用者へそのまま見せられる日本語メッセージを持つエラー。 */
export class EngineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'EngineError';
  }
}

/** 一部区間だけ失敗（server エンジン）。ジョブIDを保持して失敗区間のみ再試行できる。 */
export class PartialError extends EngineError {
  constructor(
    message: string,
    readonly jobId: string,
  ) {
    super(message);
    this.name = 'PartialError';
  }
}
