# AI文字起こし・校正・議事録 PWA（Soundcore対応）

Soundcore Work などで録音した **MP3 を Android の共有シートからそのまま受け取り**、文字起こし → 誤認識の確認 → 整文 → 議事録・要約までを、スマートフォン 1 台で行うための個人向け PWA（Progressive Web App）です。

> **重要（動作確認の範囲）**
> - 自動テスト・ブラウザ検証（Chromium）・モックProviderでの全工程は確認済みです。
> - **実際のOpenAI API、Soundcore Work 実機、Android 実機の共有シート**での確認は **未実施** です（APIキー・端末・実音声がないため）。「コード上は対応、Soundcore Work 実機確認は未実施」です。確認手順は [Android 実機テスト](#android-実機テスト) を参照してください。

## 目次
- [アプリの目的と想定ユースケース](#アプリの目的と想定ユースケース)
- [Soundcore Work からの使い方](#soundcore-work-からの使い方)
- [アーキテクチャ](#アーキテクチャ)
- [PWA と Web Share Target の仕組み](#pwa-と-web-share-target-の仕組み)
- [データの扱い（4種類を混ぜない）](#データの扱い4種類を混ぜない)
- [セットアップ・環境変数・OpenAI API 設定](#セットアップ環境変数openai-api-設定)
- [ローカル起動・テスト・ビルド](#ローカル起動テストビルド)
- [デプロイ](#デプロイ)
- [Android へのインストール](#android-へのインストール)
- [Android 実機テスト](#android-実機テスト)
- [API 利用時の注意](#api-利用時の注意)
- [プライバシー](#プライバシー)
- [現在の制限事項](#現在の制限事項)
- [今後の改善候補](#今後の改善候補)

## アプリの目的と想定ユースケース

会議・現場の録音を、**少ないタップ数で議事録まで**持っていくことが目的です。

```
Soundcore Work で録音
 → Soundcoreアプリ「音声をエクスポート」→ MP3
 → Android 共有シート → 本アプリを選択（MP3を自動受信）
 → 内容確認（ファイル名/サイズ/長さ）→「文字起こしを開始」
 → 文字起こし → 誤認識の確認（採用/却下/自分で修正）
 → 整文 → 議事録・要約・決定事項・ToDo・報告台本
```

- 入口は 2 系統：**(A) 共有シートから受信** / **(B) アプリ内の「MP3を選択」**（ファイルピッカー）。
- Soundcore 専用ではなく、一般的な MP3（m4a/wav も可）の共有に対応する汎用設計です。
- 誤共有で API 料金が発生しないよう、**受信後は必ず確認画面で止まり、「文字起こしを開始」を押して初めて外部APIへ送信**します。

## Soundcore Work からの使い方

1. 本アプリを Android Chrome で開き、ホーム画面に**インストール**する（[手順](#android-へのインストール)）。
2. 初回のみ「設定」でアクセストークンを入力する。
3. Soundcore Work で録音 →「音声をエクスポート」→ **MP3** を選ぶ。
4. Android の共有シートが開くので、**本アプリ（議事録AI）** を選ぶ。
5. 確認画面でファイル情報を確認し、「文字起こしを開始」を押す。
6. 文字起こし後、誤認識候補を確認 →「確認済みにする」→ 整文 → 議事録等を生成。

> Soundcore Work が実際に送る MIME type は公開情報では確定できないため、`audio/mpeg`・`audio/mp3`・`audio/*`・`.mp3`・`application/octet-stream` などを受け入れ、受信後に **先頭バイト（ID3/MPEGフレーム同期）とサーバー側 ffprobe** で実体を検証します。設定画面の「開発者モード」で、受信した MIME type・ファイル名・サイズを確認できます。

## アーキテクチャ

npm workspaces の monorepo（1 リポジトリ・1 Docker イメージ）です。

```
shared/   フロント/バック共通の型・定数（API契約、エラーコード、音声判定）
server/   Fastify (Node 22 / TypeScript)。API + ビルド済みPWAの静的配信 + ffmpeg
web/      React + TypeScript + Vite。PWA（vite-plugin-pwa / injectManifest）
scripts/  アイコン生成 / PWA実ブラウザ検証
```

**選定理由**
- **単一オリジン**：サーバーが API と PWA を同じ URL で配信 → CORS 不要、Share Target の POST も同一オリジンで完結、デプロイは Docker 1 個。個人が継続運用しやすい最小構成です。
- **Node/TypeScript で統一**：型（`shared/`）をフロントとバックで共有でき、保守コストが低い。
- **ffmpeg を含む Docker**：長時間 MP3 の圧縮・無音点分割に必要。特定ホスティングへ依存しません。
- **依存は最小限**：状態管理は React 標準、ルーターは hash ルーター自作、IndexedDB は `idb`、差分は `diff`、OpenAI へは SDK を使わず `fetch`。

### フロントエンド（`web/`）
| 場所 | 役割 |
|---|---|
| `src/sw.ts` | Service Worker。共有POSTの受信、アプリシェルのプリキャッシュ、更新制御 |
| `src/lib/share.ts` | `handleShare()`（SWの共有処理。単体テスト可能）、受信箱の期限掃除 |
| `src/lib/importFile.ts` | 取り込み共通処理（検証・指紋・重複検知）、`consumeShares()` |
| `src/lib/db.ts` | IndexedDB（records / audio / dictionary / settings / shareInbox） |
| `src/lib/pipeline.ts` | 文字起こし/校正/整文/生成の段階実行（二重送信防止・再実行制御） |
| `src/lib/api.ts` | バックエンド呼び出し。エラーを日本語メッセージへ変換 |
| `src/lib/{corrections,dictionary,diff,backup,exporter}.ts` | 訂正適用・辞書・差分・バックアップ・コピー/保存/共有 |
| `src/screens/` | ホーム / 記録（4ステップ）/ 履歴 / 辞書 / 設定 |

### バックエンド（`server/`）
| 場所 | 役割 |
|---|---|
| `src/app.ts` | ルーティング、認証、レート制限、アップロード受信、静的配信 |
| `src/jobs.ts` | 文字起こしジョブ（圧縮→分割→順次文字起こし→結合、再試行、一時ファイル削除） |
| `src/audio/` | `validate`（内容検証 + ffprobe）、`split`（無音点分割計画 + ffmpeg）、`merge`（結合・境界重複除去） |
| `src/providers/` | `types`（交換可能な Provider インターフェース）、`openai`、`mock` |
| `src/llm/` | 共通システム指示（創作禁止）、整文/校正/生成サービス |

**API**（`/api/*` は `Authorization: Bearer <APP_ACCESS_TOKEN>` 必須。`/api/health` のみ不要）

| メソッド | パス | 内容 |
|---|---|---|
| POST | `/api/transcribe-jobs` | MP3 を受け付けジョブ作成（multipart、`Idempotency-Key` 対応） |
| GET / DELETE | `/api/transcribe-jobs/:id` | 進捗・結果取得 / 即時削除 |
| POST | `/api/transcribe-jobs/:id/retry` | 失敗チャンクのみ再試行 |
| POST | `/api/llm/proofread` | 誤認識**候補**の抽出（strict JSON スキーマ） |
| POST | `/api/llm/polish` | 整文 |
| POST | `/api/llm/generate` | `minutes / summary / bullets / decisions / todos / script` |
| GET | `/api/config`, `/api/health` | 非機密の設定情報 / 死活監視 |

### 文字起こしの長時間対応
OpenAI の文字起こしは **1 リクエスト 25MB 上限**（2026-10 時点の公式ドキュメント）。会議音声は超えうるため、サーバーで次のように処理します。

1. アップロードを検証（0 byte / 偽装 / 破損 / サイズ・長さ上限）
2. ffmpeg で **モノラル 16kHz 32kbps MP3** に圧縮（約 14MB/時間）
3. `silencedetect` で、目標長（既定 10 分）付近の **無音区間の中央**で分割（文の途中で切らない）。無音が見つからなければ強制分割し、**3 秒オーバーラップ**
4. チャンクを順番に（並列度は設定可）文字起こし。各チャンクは指数バックオフで再試行
5. 順序通りに結合。強制分割の境界だけ、オーバーラップ重複を最長一致で除去
6. 複数チャンクの場合、`[hh:mm:ss]` の**区間開始時刻**見出しを付与
7. 一部チャンクのみ失敗した場合は成功分を保持し、**失敗区間だけ再試行**できる（一時ファイルを `JOB_TTL_MIN` だけ保持）

## PWA と Web Share Target の仕組み

`web/vite.config.ts` の manifest に `share_target` を定義しています。

```jsonc
"share_target": {
  "action": "/share-target", "method": "POST", "enctype": "multipart/form-data",
  "params": { "title": "title", "text": "text",
    "files": [{ "name": "audio", "accept": ["audio/mpeg","audio/mp3","audio/x-mpeg","audio/mpeg3","audio/x-mp3","audio/*",".mp3",".m4a",".wav","application/octet-stream"] }] }
}
```

共有時の流れ：

```
Android共有シート → POST /share-target (multipart)
 → Service Worker が fetch を横取り（src/sw.ts → handleShare）
 → File を IndexedDB「shareInbox」へランダムIDで一時保存
 → 303 See Other で「/?share=<id>」へ（ページ更新が POST 再送にならない）
 → React が share=<id> を検出 → 先に URL から share を消す
 → 受信箱から取り出して取り込み（成功・失敗にかかわらず受信箱の行を削除）
 → 記録の確認画面へ（#/r/<id>）
```

- **二重登録・再処理の防止**：URL から先にパラメータを消す／受信箱の行を消費後に削除（再読み込みしても `missing`）／内容指紋（サイズ + 先頭・中央・末尾 2MB の SHA-256）で同一音声を検知。
- **クリーンアップ**：24 時間超の未消費データを、アプリ起動時と SW の activate 時に削除。
- **SW 未制御でサーバーに届いた POST**：音声を保存せず破棄し、`/?share_error=nosw` へ 303（案内表示）。
- **更新対策**：プリキャッシュは revision 付き、旧キャッシュ自動削除。`sw.js`・`index.html`・manifest は `Cache-Control: no-cache`、ハッシュ付き `assets/` は `immutable`。新しい SW は待機し、**「更新する」を押したときだけ**有効化（処理中の強制リロードを防ぐ）。
- **オフライン**：アプリシェルと履歴は表示可。API を使う操作は無効化され、日本語で理由を表示。

## データの扱い（4種類を混ぜない）

| 種別 | 保存場所 | 説明 |
|---|---|---|
| ① 生文字起こし | `record.rawTranscript` | 音声認識の出力。**一度保存したら変更不可**（DB層で強制） |
| ② 確認済み文字起こし | `record.confirmedTranscript` | 採用/却下/手修正を反映した、ユーザーが確定した版 |
| ③ AI整文 | `record.polished` | ②から生成。①②は上書きされない |
| ④ AI生成物 | `record.outputs.*` | 議事録・要約・箇条書き・決定事項・ToDo・報告台本（各々別データ） |

誤認識の候補（原文/候補/理由/確信度）は AI も辞書も**提案のみ**で、**ユーザーが採用するまで本文は変わりません**。AI が返した候補のうち本文に実在しない `original`（幻覚）はサーバーで捨てます。差分ビューは「生→確認済み」「確認済み→整文」の 2 種類。

保存はすべて端末の IndexedDB（履歴・辞書・設定・音声）。JSON のエクスポート/インポートでバックアップできます（音声とアクセストークンは含みません。インポートは既存データを上書きしません）。

## セットアップ・環境変数・OpenAI API 設定

要件: Node.js 22.9 以上（`--env-file-if-exists` を使用）、ffmpeg / ffprobe（ローカル実行・テスト時。Docker イメージには同梱）。

```bash
npm ci
cp .env.example .env   # 編集して値を入れる（.env はコミットされません）
```

| 変数 | 必須 | 既定 | 説明 |
|---|---|---|---|
| `OPENAI_API_KEY` | ○ | – | **サーバー側のみ**。フロント・ブラウザには一切渡りません |
| `APP_ACCESS_TOKEN` | ○ | – | 本アプリへ入る合言葉（12 文字以上）。`openssl rand -base64 32` 等で生成。OpenAI キーとは別 |
| `TRANSCRIBE_MODEL` | | `gpt-transcribe` | 文字起こしモデル |
| `LLM_MODEL` | | `gpt-6.1-sol` | 整文・校正・議事録・報告台本 |
| `LLM_MODEL_LIGHT` | | `gpt-6-luna` | 要約・箇条書き・決定事項・ToDo |
| `TRANSCRIBE_LANGUAGE` | | `ja` | 言語ヒント |
| `PROVIDER` | | `openai` | `mock` で外部通信なしのデモ動作 |
| `MAX_UPLOAD_MB` / `MAX_DURATION_MIN` | | 200 / 240 | アップロード上限 |
| `CHUNK_TARGET_SEC` / `CHUNK_CONCURRENCY` | | 600 / 2 | 分割長・並列数 |
| `JOB_TTL_MIN` | | 30 | 部分失敗ジョブの一時ファイル保持上限 |
| `RATE_LIMIT_PER_MIN` | | 120 | IP あたりの簡易レート制限 |
| `PORT` / `HOST` / `ALLOW_NO_AUTH` | | 8080 / 0.0.0.0 / 0 | `ALLOW_NO_AUTH=1` はローカル開発専用 |

**OpenAI API の準備**
1. OpenAI Platform で API キーを発行し、課金設定・利用上限（月額上限）を設定する。
2. サーバーの環境変数 / Secret に `OPENAI_API_KEY` として登録する（リポジトリには書かない）。
3. モデル名は公式ドキュメント（[Speech to text](https://developers.openai.com/api/docs/guides/speech-to-text)、[Models](https://developers.openai.com/api/docs/models)）で最新を確認し、必要なら環境変数で変更する。

> 実装時（2026-10）の確認事項：文字起こしの推奨は `gpt-transcribe`、上限 25MB、MP3 対応、`gpt-transcribe` は JSON(`text`,`languages`) 応答で単語タイムスタンプは `whisper-1` のみ。**`gpt-transcribe` の用語ヒント（`keywords`）の multipart 送信形式は公式リファレンスに明記が見当たらず未検証**です。本アプリは `languages[]` / `keywords[]` を送り、HTTP 400 の場合は付与なしで 1 回だけ自動再試行します。4o 系モデルでは用語を `prompt` に埋め込みます。実 API で最初に確認してください。

## ローカル起動・テスト・ビルド

```bash
# 開発（2ターミナル）
npm run dev:server        # http://localhost:8080  （リポジトリ直下の .env を自動で読み込み）
npm run dev:web           # http://localhost:5173  （/api は 8080 へプロキシ）

# 外部通信なしで全工程を試す（モックProvider）
PROVIDER=mock ALLOW_NO_AUTH=1 npm run dev:server

npm run lint
npm run typecheck
npm test                  # server 43件 + web 66件（実APIは呼ばない。Provider/fetchをモック）
npm run build             # web/dist と server/dist を生成
npm run verify:pwa        # 要 build。Chromium で manifest/SW/共有POST/オフライン/全工程(mock)を検証
npm start                 # ビルド済みを起動（要 環境変数）
```

> Service Worker は dev サーバーでは無効です。PWA の挙動確認は `npm run build` 後の `npm start`（または `verify:pwa`）で行ってください。

`verify:pwa` は Playwright 互換の Chromium を使います（`CHROMIUM_PATH` で指定可能）。共有 POST は、ブラウザ上で `multipart/form-data` のフォームを送信して Service Worker の処理（303 → 取り込み）を再現しています。**Android の共有シート自体の再現ではありません。**

## デプロイ

要件は「**HTTPS で公開できる Node/Docker 環境**」と「環境変数の Secret 管理」だけです。

```bash
docker build -t soundcore-transcript-pwa .
docker run --rm -p 8080:8080 --env-file .env --tmpfs /tmp:size=2g soundcore-transcript-pwa
# または: docker compose up -d --build
```

- HTTPS は必須です（Service Worker / インストール / Share Target の条件）。ホスティング側の TLS、または Caddy・Cloudflare Tunnel 等で終端してください。`trustProxy` 有効（`X-Forwarded-*` を信頼）。
- 一時ファイルは `/tmp/soundcore-pwa/` のみ。`--tmpfs /tmp` でディスクに残さない構成を推奨。
- 長時間音声の処理中はサーバーが動き続ける必要があります（ジョブ状態はメモリ保持・単一インスタンス前提）。

**低コスト運用の候補**（料金・無料枠は変動するため、各社の最新情報を必ず確認してください）
- **Google Cloud Run**：コンテナをそのまま配備、HTTPS 標準。リクエスト処理中のみ課金。長時間処理は最小インスタンス数 1 / CPU 常時割り当て、タイムアウト延長が必要な場合あり。
- **Fly.io / Render / Railway 等の PaaS**：Dockerfile からデプロイ可能。小さな常時稼働インスタンスで足りる想定。
- **自宅/VPS + Cloudflare Tunnel（または Caddy）**：固定費が最も読みやすい。個人利用なら最安になりやすい。

※ 本リポジトリの作業環境では、外部サービスのアカウント作成・認証情報の取得は行っていません。

## Android へのインストール

1. Android の **Chrome** で、デプロイした `https://…` を開く。
2. メニュー（︙）→「**アプリをインストール**」または「ホーム画面に追加」。
3. ホーム画面の「議事録AI」から起動（スタンドアロン表示）。**共有先として表示されるのは、インストール済み（WebAPK 化済み）の場合のみ**です。
4. アプリの「設定」で **アクセストークン**を入力し「保存して接続確認」。

## Android 実機テスト

> 以下は**未実施**です。デプロイ後に実機で確認してください。

### 事前準備
- HTTPS で到達できる環境へデプロイし、`PROVIDER=mock`（API料金なし）または実キーで起動。
- 端末: Android + Chrome。テスト用の短い MP3（個人情報・機密を含まないもの）を用意。**実際の録音データをリポジトリへ入れないでください。**

### テスト項目（Soundcore Work あり）
| # | 手順 | 期待結果 |
|---|---|---|
| 1 | HTTPS 環境へデプロイ | `https://…/api/health` が `{"ok":true}` |
| 2 | Android Chrome でアプリを開く | ホーム画面が表示される |
| 3 | 「アプリをインストール」 | ホーム画面にアイコンが追加される |
| 4 | 設定でアクセストークン保存・接続確認 | 「OK」と各モデル名が表示される |
| 5 | Soundcore Work で短い会議を録音 | – |
| 6 | Soundcore アプリで「音声をエクスポート」 | – |
| 7 | **MP3** を選択 | Android の共有シートが開く |
| 8 | 共有シートで本アプリが候補に出るか確認 | 「議事録AI」が表示される |
| 9 | 本アプリを選択 | アプリが起動し確認画面が出る（**自動で文字起こしは始まらない**） |
| 10 | 確認画面の内容を確認 | ファイル名・サイズ・長さが正しい。「文字起こしを開始」を押すまで送信されない |
| 11 | 設定 → 開発者モード ON → 再度共有 | 受信 MIME type / ファイル名 / サイズが表示される（Soundcore の実 MIME を記録） |
| 12 | 同じ MP3 を再度共有 | 「既に取り込み済み」と表示され、記録が増えない |
| 13 | アプリ画面を更新（引っ張る/再起動） | 二重登録・再処理されない |
| 14 | 「文字起こしを開始」→ 完了後 | 生文字起こし表示、音声が自動削除される（設定による） |

### Soundcore Work が手元にない場合の代替
1. 端末の **ファイル管理アプリ**（Files by Google 等）で、テスト用 MP3 を長押し →「共有」→ 本アプリを選ぶ。
2. または Chrome/ブラウザで MP3 をダウンロード →「ダウンロード」画面から共有。
3. 他の録音アプリ・メッセージアプリ・Google ドライブの「共有」からも同様に確認できます。
4. 共有シートに出ない場合：アプリを**一度アンインストールして再インストール**（`share_target` の変更は WebAPK の更新反映に時間がかかることがあります）、Chrome を最新化、インストール後に一度アプリを起動、HTTPS であることを確認。
5. 共有後に「共有の受信に失敗」が出る場合：アプリを一度開いて Service Worker が有効になってから再度共有する。「MP3を選択」からのファイル選択は共有に依存せず利用できます。

## API 利用時の注意
- 外部 AI サービスへ**音声と文字起こし全文**が送信され、**従量課金**が発生します。長時間音声ほど費用が増えます。OpenAI 側で月額上限を設定してください。
- 誤送信防止：受信後は確認画面で停止／段階ごとの二重送信防止（実行中ロック＋同一リクエストの冪等キー）／完了済みの段階は再実行しない（「再生成」は確認ダイアログ付きの明示操作）／校正→整文→議事録を**個別に**実行。
- AI の出力には誤りが含まれ得ます。固有名詞・数値・決定事項は、必ず確認済み文字起こしと照合してください。
- LLM への指示は創作・推測を禁じ、不確かな箇所に【要確認】を付ける設計ですが、完全な保証はできません。

## プライバシー
- 画面に「外部AIサービスへ音声を送信します。利用する音声について、所属組織の規程や関係者の同意等を確認してください。」を表示します。
- **サーバーの音声一時保存**
  - 目的：圧縮・分割・失敗区間の再試行のためだけ。
  - 場所：`<OS tmpdir>/soundcore-pwa/job-<ランダム>/`（0700、ファイル名はサーバー側生成。ユーザー指定のファイル名はパスに使いません）。
  - 削除：原本は圧縮直後に削除／成功時は直ちに全削除／認証・上限など再試行しても無駄な失敗は直ちに削除／部分失敗のみ `JOB_TTL_MIN`（既定 30 分）保持後に自動削除／クライアントの `DELETE`／サーバー起動時に残骸を全削除／定期スイーパー。エラー終了時も cleanup されます。
  - 完了ジョブの文字起こし結果もメモリ上のみで、TTL 後または `DELETE` で消えます（クライアントは保存後に削除要求）。
- ログには音声内容・文字起こし本文・APIキーを出力しません（ジョブID・件数・所要時間・エラーコードのみ）。
- OpenAI へは `store: false` で LLM を呼び出します（API 側のデータ取り扱いは OpenAI の最新ポリシーを確認してください）。
- 端末側：履歴・辞書・音声は IndexedDB のみ。音声は「音声を削除」で明示削除でき、既定では文字起こし完了後に自動削除します。アクセストークン（OpenAI キーではない）は端末の IndexedDB に保存されます。
- 不要な外部通信はありません（外部フォント/解析/CDN なし。通信先は自サーバーと、サーバーから OpenAI のみ）。

## 現在の制限事項
- 実 OpenAI API / Soundcore Work 実機 / Android 実機の共有シートは未確認（上記参照）。`gpt-transcribe` の `keywords` 形式は未検証。
- タイムスタンプは**区間単位**（`gpt-transcribe` は単語タイムスタンプ非対応）。話者分離は未対応。
- ジョブ状態はサーバーメモリ保持・単一インスタンス前提。サーバー再起動で進行中ジョブは失われます（クライアントは `job_not_found` を検知し再アップロードを促します）。
- 長大な文字起こし（数万字超）の整文・校正は分割処理しますが、議事録等の生成は 1 回のリクエストです（非常に長い会議では出力が薄くなる可能性）。
- 強制分割境界の重複除去は「完全一致」のみ（言い回しが揺れた重複は残り得る）。
- 音声はサーバー経由のアップロード（長時間・大容量は携帯回線で時間がかかる。アップロードの途中再開は未対応）。
- 自動開始（受信後すぐ文字起こし）は設定項目のみで、現状は常に確認画面を表示します。
- iPhone は対象外（Web Share Target 非対応）。
- アクセス制御は共有トークン 1 つの簡易方式（複数ユーザー管理なし）。

## 今後の改善候補
- 実機での MIME 実測に基づく `accept` の調整、自動開始設定の実装。
- アップロードのチャンク化・再開、ジョブ永続化（再起動耐性）。
- 話者分離（`gpt-4o-transcribe-diarize`）、`whisper-1` による単語タイムスタンプ。
- 長時間会議向けの階層的要約（map-reduce）、議題ごとの議事録テンプレート。
- 端末内の暗号化バックアップ、Web Push での完了通知。
- 他 Provider（Whisper ローカル、他社 STT/LLM）の追加。
