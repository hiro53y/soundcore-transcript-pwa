import type { TextEngineId, TranscribeEngineId } from './types';

export const TRANSCRIBE_LABELS: Record<TranscribeEngineId, string> = {
  local: 'この端末内（Whisper・無料・おすすめ）',
  gemini: 'Google Gemini（無料枠・高速・長時間向け）',
  server: '自前サーバー（上級者向け）',
};
export const TEXT_LABELS: Record<TextEngineId, string> = {
  rules: '簡易（AIなし・無料）',
  gemini: 'Google Gemini（無料枠・高品質）',
  server: '自前サーバー（上級者向け）',
};
