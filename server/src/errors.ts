import type { ApiErrorBody, ApiErrorCode } from '@app/shared';

const DEFAULT_MESSAGES: Record<ApiErrorCode, string> = {
  unauthorized: 'アクセストークンが正しくありません。設定画面で確認してください。',
  api_key_missing: 'サーバーにOpenAI APIキーが設定されていません。管理者設定（OPENAI_API_KEY）を確認してください。',
  provider_auth_failed: 'AIサービスの認証に失敗しました。サーバーのAPIキーを確認してください。',
  rate_limited: 'AIサービスが混み合っています。少し待ってから再試行してください。',
  quota_exceeded: 'AIサービスの利用上限に達しました。利用枠・課金設定を確認してください。',
  file_empty: 'ファイルが空（0バイト）です。',
  file_too_large: 'ファイルが大きすぎます。',
  file_not_audio: '対応している音声ファイルではありません（MP3等を選択してください）。',
  file_corrupt: '音声ファイルが壊れているか、読み取れませんでした。',
  duration_too_long: '音声が長すぎます。',
  timeout: 'AIサービスの応答がタイムアウトしました。再試行してください。',
  provider_error: 'AIサービスでエラーが発生しました。しばらくして再試行してください。',
  partial_failure: '一部の区間の文字起こしに失敗しました。失敗した区間だけ再試行できます。',
  job_not_found: '処理が見つかりません（保持期限切れの可能性があります）。もう一度アップロードしてください。',
  job_busy: 'この処理は現在実行中です。',
  bad_request: 'リクエストが正しくありません。',
  internal: 'サーバー内部でエラーが発生しました。',
};

const STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  api_key_missing: 503,
  provider_auth_failed: 502,
  rate_limited: 429,
  quota_exceeded: 402,
  file_empty: 400,
  file_too_large: 413,
  file_not_audio: 415,
  file_corrupt: 422,
  duration_too_long: 413,
  timeout: 504,
  provider_error: 502,
  partial_failure: 207,
  job_not_found: 404,
  job_busy: 409,
  bad_request: 400,
  internal: 500,
};

const RETRYABLE = new Set<ApiErrorCode>(['rate_limited', 'timeout', 'provider_error', 'partial_failure']);

export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: ApiErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? DEFAULT_MESSAGES[code], options);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.retryable = RETRYABLE.has(code);
  }
  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, retryable: this.retryable } };
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
