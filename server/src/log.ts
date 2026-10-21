/**
 * 構造化ログ。音声内容・文字起こし本文・APIキーは絶対に渡さないこと。
 * ジョブID・サイズ・所要時間・エラーコード等の診断情報のみ記録する。
 */
export type LogFn = (event: string, data?: Record<string, string | number | boolean | undefined>) => void;

export const log: LogFn = (event, data) => {
  if (process.env.VITEST) return;
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
};
