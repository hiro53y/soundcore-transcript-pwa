/** フロントエンドとバックエンドで共有する型・定数。 */

export const OUTPUT_KINDS = ['minutes', 'summary', 'bullets', 'decisions', 'todos', 'script'] as const;
export type OutputKind = (typeof OUTPUT_KINDS)[number];

export const OUTPUT_LABELS: Record<OutputKind, string> = {
  minutes: '議事録',
  summary: '短い要約',
  bullets: '箇条書き要約',
  decisions: '決定事項',
  todos: 'ToDo / Action Items',
  script: '報告用台本',
};

/** ユーザー向けに分かりやすい日本語へ変換できる、APIの機械可読エラーコード。 */
export const API_ERROR_CODES = [
  'unauthorized',
  'api_key_missing',
  'provider_auth_failed',
  'rate_limited',
  'quota_exceeded',
  'file_empty',
  'file_too_large',
  'file_not_audio',
  'file_corrupt',
  'duration_too_long',
  'timeout',
  'provider_error',
  'partial_failure',
  'job_not_found',
  'job_busy',
  'bad_request',
  'internal',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string; retryable: boolean };
}

export type ChunkStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ChunkInfo {
  index: number;
  startSec: number;
  endSec: number;
  status: ChunkStatus;
  attempts: number;
  /** 完了時のみ。 */
  text?: string;
  errorCode?: ApiErrorCode;
}

export type JobStatus = 'queued' | 'preparing' | 'transcribing' | 'done' | 'partial' | 'failed';

export interface JobView {
  id: string;
  status: JobStatus;
  durationSec?: number;
  chunks: ChunkInfo[];
  /** done のときのみ結合済み全文。partial のときは成功チャンク分の暫定結合。 */
  text?: string;
  errorCode?: ApiErrorCode;
  /** 一時ファイルがサーバー上に残っている（再試行可能）か。 */
  retryable: boolean;
  expiresAt?: string;
}

export interface DictionaryTerm {
  id: string;
  /** 正式表記（例: CGL） */
  term: string;
  /** 誤認識されやすい表記（例: シージーエル） */
  misrecognitions: string[];
  note?: string;
}

/** サーバーへ渡す辞書。ID等の不要情報は含めない。 */
export interface DictionaryContext {
  terms: { term: string; misrecognitions: string[] }[];
}

export type Confidence = 'high' | 'medium' | 'low';
export type CorrectionDecision = 'pending' | 'accepted' | 'rejected' | 'edited';

export interface CorrectionCandidate {
  id: string;
  original: string;
  suggestion: string;
  reason: string;
  confidence: Confidence;
  source: 'ai' | 'dictionary';
}

export interface Correction extends CorrectionCandidate {
  decision: CorrectionDecision;
  /** decision === 'edited' のときユーザーが入力した最終表記。 */
  finalText?: string;
}

export interface ProofreadRequest {
  text: string;
  dictionary?: DictionaryContext;
}
export interface ProofreadResponse {
  candidates: CorrectionCandidate[];
}

export interface PolishRequest {
  text: string;
  dictionary?: DictionaryContext;
}
export interface GenerateRequest {
  kind: OutputKind;
  text: string;
  title?: string;
  dictionary?: DictionaryContext;
}
export interface TextResponse {
  text: string;
  model: string;
}

export interface ConfigResponse {
  provider: string;
  transcribeModel: string;
  llmModel: string;
  llmModelLight: string;
  maxUploadMb: number;
  maxDurationMin: number;
  hasApiKey: boolean;
}

export const ACCEPTED_EXTENSIONS = ['.mp3', '.mpga', '.mpeg', '.m4a', '.wav', '.webm', '.mp4'] as const;

/** 共有元アプリによってMIMEが異なる可能性があるため、audio/* 全般 + 空/octet-stream を許容する。 */
export function isAcceptedAudioType(name: string, mime: string): boolean {
  const lower = name.toLowerCase();
  const extOk = ACCEPTED_EXTENSIONS.some((e) => lower.endsWith(e));
  const m = mime.toLowerCase();
  if (m.startsWith('audio/')) return true;
  if (m === 'video/mp4' || m === 'video/webm') return extOk;
  if (m === '' || m === 'application/octet-stream' || m === 'binary/octet-stream') return extOk;
  return false;
}

/** 秒 → hh:mm:ss */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(r)}`;
}

export type SniffedKind = 'mp3' | 'wav' | 'mp4' | 'webm' | 'ogg';

/** 先頭バイトから音声コンテナを判定する。拡張子・MIMEは偽装できるため内容で確認する。 */
export function sniffAudio(head: Uint8Array): SniffedKind | null {
  if (head.length < 4) return null;
  const s = (i: number, n: number) => String.fromCharCode(...head.slice(i, i + n));
  if (s(0, 3) === 'ID3') return 'mp3';
  if (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0) return 'mp3'; // MPEG frame sync
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') return 'wav';
  if (head.length >= 12 && s(4, 4) === 'ftyp') return 'mp4';
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'webm';
  if (s(0, 4) === 'OggS') return 'ogg';
  return null;
}


export * from './prompts';
export * from './llmText';
