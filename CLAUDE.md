# CLAUDE.md

Android 向け PWA「AI文字起こし・校正・議事録」。Soundcore Work 等の MP3 を **Android 共有シート（Web Share Target）** で受け取り、文字起こし → 誤認識確認 → 整文 → 議事録を作る個人利用アプリ。詳細は README.md。UI・ドキュメントは日本語。

## 主要アーキテクチャ
- npm workspaces monorepo。1 Docker イメージ（Node 22 + ffmpeg）が API と ビルド済み PWA を**同一オリジン**で配信。
- `shared/` 型・定数 / `server/` Fastify（TS, esbuild で単一バンドル）/ `web/` React + Vite + vite-plugin-pwa(injectManifest)。
- 外部通信は **サーバー → OpenAI のみ**。フロントは自サーバーの `/api/*` だけを呼ぶ。
- Provider 抽象（`server/src/providers/types.ts`）：`TranscriptionProvider` / `LlmProvider`。実装は `openai` と `mock`（`PROVIDER=mock`）。モデル名は環境変数（`TRANSCRIBE_MODEL` / `LLM_MODEL` / `LLM_MODEL_LIGHT`）。コード・UIに直書きしない。
- 長時間音声：ffmpeg で 32kbps モノラルへ圧縮 → 無音点で分割 → チャンク順次文字起こし → 結合（`server/src/jobs.ts`, `audio/`）。OpenAI の上限は 25MB/リクエスト。

## ディレクトリ
```
shared/src/index.ts        共通型・エラーコード・isAcceptedAudioType・sniffAudio
server/src/app.ts          ルーティング・認証・アップロード・静的配信
server/src/jobs.ts         ジョブ管理 + 一時ファイルのライフサイクル
server/src/audio/          validate / split / merge
server/src/providers/      types / openai / mock
server/src/llm/            prompts（創作禁止の共通ルール）/ service
server/test/               vitest（ffmpegで合成MP3を生成して使用）
web/src/sw.ts              Service Worker（share_target POST 受信）
web/src/lib/               db, share, importFile, pipeline, api, corrections, dictionary, diff, backup, exporter
web/src/screens/           Home, Record(4ステップ), History, Dictionary, Settings
web/vite.config.ts         manifest（share_target はここ）
scripts/                   generate-icons.mjs, verify-pwa.mjs
```

## 開発コマンド
```bash
npm ci
npm run dev:server        # PROVIDER=mock ALLOW_NO_AUTH=1 で外部通信なし起動可（.env を自動読込）
npm run dev:web           # /api は :8080 へプロキシ。SWは dev では無効
npm run lint && npm run typecheck && npm test && npm run build   # CI と同じ
npm run verify:pwa        # build 後。Chromium で manifest/SW/共有POST/オフライン/全工程(mock)
npm run icons             # アイコン再生成（web/public/icons をコミット）
```
テスト：server 43 + web 66。実 API は絶対に呼ばない（Provider / fetch をモック）。ffmpeg が必要（サーバーテスト）。

## 設計原則
1. **4種のテキストを混ぜない**：①生文字起こし `rawTranscript`（不変。`putRecord` が上書きを拒否）②確認済み `confirmedTranscript` ③整文 `polished` ④生成物 `outputs.*`。AI は①②を上書きしない。
2. **AI は候補を出すだけ**：誤認識候補は `pending` で保存し、採用/却下/修正はユーザー操作のみ。LLM 出力の `original` が本文に無ければサーバーで破棄。
3. **コスト防止**：自動で外部 API へ送らない（受信 → 確認画面 → 「文字起こしを開始」）。段階ごとに実行中ロック、完了済みは `force` なしで再実行しない、再生成は確認ダイアログ。
4. **LLM 指示は一元管理**（`llm/prompts.ts` の `CORE_RULES`）：入力に無い事実・数値・固有名詞を創作しない、不確かなら【要確認】。新しい生成物を足すときも必ず `CORE_RULES` を前置する。
5. エラーは `AppError`（機械可読コード）→ クライアントで日本語メッセージ。スタックトレースを画面に出さない。
6. 依存は増やさない（状態管理ライブラリ・UIキット・OpenAI SDK は不採用）。

## 絶対に守る制約
- **OpenAI APIキーをフロント・バンドル・localStorage・IndexedDB・ログ・Git に入れない**。`OPENAI_API_KEY` はサーバー環境変数のみ。`.env` はコミット禁止（`.env.example` のみ）。`/api/config` はキー本体を返さない。
- `APP_ACCESS_TOKEN`（アプリ用の合言葉）は OpenAI キーとは別物。未設定ではサーバーが起動しない（`ALLOW_NO_AUTH=1` のローカル開発のみ例外）。
- **実音声・実録音をリポジトリに含めない**（`.gitignore` で `*.mp3` 等を除外）。テストは ffmpeg 合成音または先頭 `ID3` のダミーバイトを使う。
- 外部へ余計な通信（CDN・フォント・解析）を足さない。

## 音声データ取扱ルール
- サーバー上の音声は **一時保存のみ**：`<tmpdir>/soundcore-pwa/job-<random>/`（0700）。ファイル名はサーバー生成、**ユーザー指定名をパスに使わない**。
- 削除タイミング：原本は圧縮直後／成功時は即時／恒久エラー（認証・上限）は即時／部分失敗のみ `JOB_TTL_MIN` 保持／起動時に残骸全削除／定期スイーパー／`DELETE`。**新しいエラー経路を足すときも cleanup を必ず通す**（`jobs.ts` の `removeDir`、`app.ts` の `finally`）。
- **ログに音声内容・文字起こし本文・キーを出さない**（`log.ts` はIDと数値のみ）。
- 端末側の音声は IndexedDB `audio` ストア。既定は文字起こし完了後に自動削除、「音声を削除」で明示削除可。バックアップに音声は含めない。

## PWA / share_target 周辺の注意点
- `share_target`（`web/vite.config.ts`）は `method: POST` / `enctype: multipart/form-data` / `files[].name = 'audio'`。**accept は audio/mpeg・audio/mp3・audio/*・.mp3 に加え application/octet-stream を許容**（Soundcore の実 MIME が未確定のため）。受信後に先頭バイト（`sniffAudio`）と ffprobe で実体検証する。MIME だけで信用しない。
- 共有 POST は **Service Worker が処理**（`sw.ts` → `lib/share.ts handleShare`）：IndexedDB `shareInbox` に保存 → **303** で `/?share=<id>`。`Response.redirect` は使わず `Location` ヘッダ付き 303 を返す。
- ページ側（`App.tsx handleShareParams`）は **先に URL から `share` を消し**、受信箱から取り出し → 取り込み → **成功/失敗に関わらず行を削除**。これで更新・戻る・二重共有でも再処理されない。内容指紋で重複も検知。順序を変えないこと。
- SW の `fetch` リスナー（POST /share-target）は workbox ルート登録より前。`NavigationRoute` の denylist に `/api/` と `/share-target`。`/api/*` は絶対にキャッシュしない。
- 新 SW は待機し、ユーザーが「更新する」を押したときだけ `SKIP_WAITING`（処理中の強制リロード防止）。`sw.js`・`index.html`・manifest は `no-cache`、`assets/` は immutable（`server/src/app.ts` の `setHeaders`）。
- IndexedDB のスキーマは `web/src/lib/db.ts` の `openAppDB` に**一箇所だけ**定義（SW とページで共有）。スキーマ変更時は `DB_VERSION` を上げて `upgrade` を書く。
- manifest/`share_target` を変えた後は、Android の WebAPK への反映に時間がかかる／再インストールが必要なことがある。
- Share Target は **HTTPS + インストール済み PWA + Android Chrome** でのみ動く。デスクトップでは `verify:pwa` が「フォームPOST→SW→303」を再現するだけで、共有シートそのものは再現できない。
- **未確認事項**（実機・実キーが必要）：Soundcore Work 実機の MIME/共有挙動、Android 共有シートへの表示、実 OpenAI API、`gpt-transcribe` の `keywords` 送信形式（`providers/openai.ts` に 400 時フォールバックあり）。完了報告で「動作確認済み」と書かない。

## 変更時のチェックリスト
- 新しい API/エラー → `shared` のコードと `server/src/errors.ts`（日本語メッセージ）と `web/src/lib/api.ts` を揃える。
- DB/モデル変更 → `RecordItem`（`web/src/lib/types.ts`）、バックアップ検証（`backup.ts`）、テストを更新。
- 完了前に `lint / typecheck / test / build / verify:pwa` を実行。
