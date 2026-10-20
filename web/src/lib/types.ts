import type { Correction, DictionaryTerm, OutputKind } from '@app/shared';

export type StageStatus = 'idle' | 'running' | 'done' | 'error';

export interface StageState {
  status: StageStatus;
  /** 利用者向けの日本語メッセージ（status === 'error' のとき）。 */
  error?: string;
  at?: string;
}

export interface GeneratedText {
  text: string;
  model: string;
  createdAt: string;
}

export interface RecordItem {
  id: string;
  title: string;
  fileName: string;
  fileSize: number;
  durationSec?: number;
  createdAt: string;
  updatedAt: string;
  source: 'share' | 'picker';
  /** 重複取り込み検知用の指紋（サイズ + 一部バイトのSHA-256）。 */
  fingerprint: string;
  stages: {
    transcribe: StageState;
    proofread: StageState;
    polish: StageState;
    outputs: Partial<Record<OutputKind, StageState>>;
  };
  /** ① 生文字起こし。一度保存したら変更しない（db層で強制）。 */
  rawTranscript?: string;
  /** ② ユーザー確認済み文字起こし。 */
  confirmedTranscript?: string;
  confirmedAt?: string;
  corrections: Correction[];
  /** 全文を直接編集中の下書き（候補の自動反映を止める）。 */
  manualEdit?: string;
  /** ③ AI整文。 */
  polished?: GeneratedText;
  /** ④ AI生成物（議事録など）。 */
  outputs: Partial<Record<OutputKind, GeneratedText>>;
  /** サーバー側文字起こしジョブ（再開用）。 */
  jobId?: string;
  /** 部分失敗などで保持中の進捗（表示用）。 */
  jobProgress?: { done: number; total: number };
  audioDeleted: boolean;
}

export interface AudioRow {
  id: string;
  blob: Blob;
  mime: string;
}

export interface ShareInboxRow {
  id: string;
  file: Blob;
  fileName: string;
  mime: string;
  size: number;
  receivedAt: number;
  title?: string;
  text?: string;
}

export interface Settings {
  /** サーバーへのアクセス用合言葉（OpenAI APIキーではない）。 */
  accessToken: string;
  /** 文字起こし完了後に音声を自動削除（既定: 有効）。 */
  autoDeleteAudio: boolean;
  /** 受信後に確認なしで文字起こしを開始（既定: 無効。誤送信による課金防止）。 */
  autoStart: boolean;
  /** 開発者モード: 受信情報の表示。 */
  devMode: boolean;
  /** 直近の共有受信情報（開発者モード用）。 */
  lastShare?: { fileName: string; mime: string; size: number; receivedAt: number; via: 'share' | 'picker' };
}

export const DEFAULT_SETTINGS: Settings = {
  accessToken: '',
  autoDeleteAudio: true,
  autoStart: false,
  devMode: false,
};

export type DictionaryEntry = DictionaryTerm;

export interface BackupFile {
  app: 'soundcore-transcript-pwa';
  version: 1;
  exportedAt: string;
  records: RecordItem[];
  dictionary: DictionaryEntry[];
  settings: Omit<Settings, 'accessToken'>;
}
