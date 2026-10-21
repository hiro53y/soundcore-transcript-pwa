import type { TextEngineId, TranscribeEngineId } from './types';

/** 送信前に必ず表示する、方式ごとのプライバシー注意文。 */
export function privacyNoticeFor(t: TranscribeEngineId): string {
  switch (t) {
    case 'local':
      return '音声はこの端末の中だけで処理され、外部へ送信されません。';
    case 'gemini':
      return '外部AIサービス（Google Gemini）へ音声を送信します。無料枠では入力内容が Google の製品改善に使われる場合があります。利用する音声について、所属組織の規程や関係者の同意等を確認してください。';
    case 'server':
      return '外部AIサービスへ音声を送信します。利用する音声について、所属組織の規程や関係者の同意等を確認してください。';
  }
}

export function textPrivacyNoticeFor(t: TextEngineId): string {
  switch (t) {
    case 'rules':
      return 'この端末内の簡易処理（AIなし）です。文字起こしの内容は外部へ送信されません。';
    case 'gemini':
      return '文字起こしの全文を Google Gemini へ送信します。無料枠では入力内容が Google の製品改善に使われる場合があります。利用する内容について、所属組織の規程や関係者の同意等を確認してください。';
    case 'server':
      return '文字起こしの全文を外部AIサービスへ送信します。利用する内容について、所属組織の規程や関係者の同意等を確認してください。';
  }
}
