import os from 'node:os';
import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  provider: 'openai' | 'mock';
  openaiApiKey: string;
  openaiBaseUrl: string;
  accessToken: string;
  allowNoAuth: boolean;
  transcribeModel: string;
  llmModel: string;
  llmModelLight: string;
  transcribeLanguage: string;
  maxUploadBytes: number;
  maxDurationSec: number;
  chunkTargetSec: number;
  chunkConcurrency: number;
  chunkOverlapSec: number;
  chunkMaxAttempts: number;
  retryBaseDelayMs: number;
  jobTtlMs: number;
  rateLimitPerMin: number;
  tmpRoot: string;
  webDist: string;
  requestTimeoutMs: number;
}

function num(v: string | undefined, def: number): number {
  if (v === undefined || v.trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const provider = env.PROVIDER === 'mock' ? 'mock' : 'openai';
  const cfg: Config = {
    port: num(env.PORT, 8080),
    host: env.HOST || '0.0.0.0',
    provider,
    openaiApiKey: env.OPENAI_API_KEY ?? '',
    openaiBaseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    accessToken: env.APP_ACCESS_TOKEN ?? '',
    allowNoAuth: env.ALLOW_NO_AUTH === '1',
    transcribeModel: env.TRANSCRIBE_MODEL || 'gpt-transcribe',
    llmModel: env.LLM_MODEL || 'gpt-6.1-sol',
    llmModelLight: env.LLM_MODEL_LIGHT || 'gpt-6-luna',
    transcribeLanguage: env.TRANSCRIBE_LANGUAGE ?? 'ja',
    maxUploadBytes: num(env.MAX_UPLOAD_MB, 200) * 1024 * 1024,
    maxDurationSec: num(env.MAX_DURATION_MIN, 240) * 60,
    chunkTargetSec: num(env.CHUNK_TARGET_SEC, 600),
    chunkConcurrency: Math.max(1, Math.floor(num(env.CHUNK_CONCURRENCY, 2))),
    chunkOverlapSec: 3,
    chunkMaxAttempts: 3,
    retryBaseDelayMs: 1500,
    jobTtlMs: num(env.JOB_TTL_MIN, 30) * 60 * 1000,
    rateLimitPerMin: num(env.RATE_LIMIT_PER_MIN, 120),
    tmpRoot: path.join(os.tmpdir(), 'soundcore-pwa'),
    webDist: env.WEB_DIST || path.resolve(import.meta.dirname, '../../web/dist'),
    requestTimeoutMs: 10 * 60 * 1000,
  };
  return { ...cfg, ...overrides };
}

/** 起動時に致命的な設定不備を検出する。メッセージには秘密値を含めない。 */
export function assertStartable(cfg: Config): void {
  if (!cfg.accessToken && !cfg.allowNoAuth) {
    throw new Error(
      'APP_ACCESS_TOKEN が未設定です。公開環境でAPIキーを第三者に使われないよう必須にしています。' +
        '（ローカル開発のみ ALLOW_NO_AUTH=1 で回避可能）',
    );
  }
  if (cfg.accessToken && cfg.accessToken.length < 12 && !cfg.allowNoAuth) {
    throw new Error('APP_ACCESS_TOKEN が短すぎます。12文字以上のランダム文字列にしてください。');
  }
}
