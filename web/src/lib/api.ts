import type {
  ApiErrorBody,
  ConfigResponse,
  CorrectionCandidate,
  DictionaryContext,
  GenerateRequest,
  JobView,
  OutputKind,
  TextResponse,
} from '@app/shared';

export type ClientErrorCode = ApiErrorBody['error']['code'] | 'offline' | 'network' | 'aborted';

export class ApiError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken = '';
export function setAccessToken(t: string): void {
  accessToken = t;
}

function authHeaders(): Record<string, string> {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

function offlineOrNetwork(): ApiError {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return new ApiError('offline', 'オフラインです。ネットワークに接続してからやり直してください（取り込んだ音声や履歴は端末に残っています）。', true);
  }
  return new ApiError('network', 'サーバーに接続できませんでした。電波状況を確認して再試行してください。', true);
}

async function toApiError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as ApiErrorBody;
    if (body?.error?.code) return new ApiError(body.error.code, body.error.message, body.error.retryable);
  } catch {
    /* 本文なし */
  }
  if (res.status === 401) return new ApiError('unauthorized', 'アクセストークンが正しくありません。設定画面で確認してください。');
  if (res.status === 502 || res.status === 503 || res.status === 504) return new ApiError('provider_error', 'サーバーが一時的に利用できません。しばらくして再試行してください。', true);
  return new ApiError('internal', `サーバーエラーが発生しました（HTTP ${res.status}）。`, res.status >= 500);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) } });
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw new ApiError('aborted', '中断しました。');
    throw offlineOrNetwork();
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  config: () => request<ConfigResponse>('/api/config'),
  getJob: (id: string) => request<JobView>(`/api/transcribe-jobs/${id}`),
  retryJob: (id: string) => request<JobView>(`/api/transcribe-jobs/${id}/retry`, { method: 'POST' }),
  deleteJob: (id: string) => request<void>(`/api/transcribe-jobs/${id}`, { method: 'DELETE' }),
  proofread: (text: string, dictionary?: DictionaryContext) =>
    request<{ candidates: CorrectionCandidate[] }>('/api/llm/proofread', json('POST', { text, dictionary })),
  polish: (text: string, dictionary?: DictionaryContext) => request<TextResponse>('/api/llm/polish', json('POST', { text, dictionary })),
  generate: (kind: OutputKind, text: string, title?: string, dictionary?: DictionaryContext) =>
    request<TextResponse>('/api/llm/generate', json('POST', { kind, text, title, dictionary } satisfies GenerateRequest)),
};

/** 進捗(アップロード%)を出すため XMLHttpRequest を使う。音声は必ずバックエンド経由で送る。 */
export function uploadAudio(
  blob: Blob,
  opts: { dictionary?: DictionaryContext; idempotencyKey: string; onProgress?: (ratio: number) => void; signal?: AbortSignal },
): Promise<JobView> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/transcribe-jobs');
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader('Idempotency-Key', opts.idempotencyKey);
    xhr.upload.onprogress = (e) => e.lengthComputable && opts.onProgress?.(e.loaded / e.total);
    xhr.onerror = () => reject(offlineOrNetwork());
    xhr.ontimeout = () => reject(new ApiError('timeout', 'アップロードがタイムアウトしました。電波の良い場所で再試行してください。', true));
    xhr.onabort = () => reject(new ApiError('aborted', '中断しました。'));
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) return resolve(body as JobView);
        const err = (body as ApiErrorBody).error;
        reject(new ApiError(err.code, err.message, err.retryable));
      } catch {
        reject(new ApiError(xhr.status === 401 ? 'unauthorized' : 'internal', xhr.status === 401 ? 'アクセストークンが正しくありません。' : `サーバーエラーが発生しました（HTTP ${xhr.status}）。`, xhr.status >= 500));
      }
    };
    opts.signal?.addEventListener('abort', () => xhr.abort());
    const form = new FormData();
    if (opts.dictionary) form.append('dictionary', JSON.stringify(opts.dictionary)); // ファイルより先に付ける
    form.append('audio', blob, 'audio.mp3');
    xhr.send(form);
  });
}

/** 画面に出すための日本語メッセージ。スタックトレース等は出さない。 */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if ((e as { name?: string })?.name === 'StorageError') return (e as Error).message;
  if ((e as { name?: string })?.name === 'QuotaExceededError') return '端末の保存容量が不足しています。不要な履歴や音声を削除してください。';
  return '予期しないエラーが発生しました。もう一度お試しください。';
}
