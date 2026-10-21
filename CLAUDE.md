# CLAUDE.md

Android 向け PWA「AI文字起こし・校正・議事録」。Soundcore Work 等の MP3 を **Android 共有シート（Web Share Target）** で受け取り、文字起こし → 誤認識確認 → 整文 → 議事録を作る個人利用アプリ。詳細は README.md。UI・ドキュメントは日本語。

## 主要アーキテクチャ
- **既定は「課金なし・サーバーなし」**：`web/` だけで完結する静的PWAを **GitHub Pages**（`.github/workflows/pages.yml`、main への push で公開）に置く。ユーザー要件は「課金不可・すぐ使える」。
- npm workspaces monorepo：`shared/`（型・定数・LLM共通プロンプト）/ `web/`（React + Vite + vite-plugin-pwa injectManifest）/ `server/`（**任意**の自前サーバー方式：Fastify + ffmpeg + OpenAI。課金あり）。
- **エンジン抽象**（`web/src/lib/engines/`）：文字起こし `local`（既定。端末内Whisper = transformers.js + ONNX/WASM、Web Worker）｜`gemini`｜`server`、整文・生成 `rules`（既定。AIなしルールベース）｜`gemini`｜`server`。設定(`Settings.transcribeEngine/textEngine`)で選択。`pipeline.ts` は必ずエンジン経由で呼ぶ（api/fetchを直接呼ばない）。
- 配信パス `VITE_BASE`（既定 `/`、Pagesは `/<リポジトリ名>/`）で manifest の `start_url/scope/id/share_target.action`、SW、アセットが連動。
- 外部通信：端末内=初回モデル取得(Hugging Faceのみ。onnxruntime wasmは自サイト `<base>ort/` から配信、CDN禁止)／Gemini=ブラウザ→Google／server=サーバー→OpenAI。
- server方式の Provider 抽象（`server/src/providers/types.ts`）と長時間音声処理（ffmpeg圧縮→無音点分割→順次→結合、25MB/リクエスト）は従来どおり。モデル名は環境変数。コード・UIに直書きしない（Geminiモデル名は設定で変更可能）。

## ディレクトリ
```
shared/src/index.ts        共通型・エラーコード・isAcceptedAudioType・sniffAudio
shared/src/prompts.ts      LLM共通プロンプト（CORE_RULES=創作禁止）。server と Gemini で共用
shared/src/llmText.ts      splitForLlm / sanitizeCandidates（幻覚候補の除去）
server/src/app.ts          ルーティング・認証・アップロード・静的配信
server/src/jobs.ts         ジョブ管理 + 一時ファイルのライフサイクル
server/src/audio/          validate / split / merge
server/src/providers/      types / openai / mock
server/src/llm/            service（プロンプトは shared）
server/test/               vitest（ffmpegで合成MP3を生成して使用）
web/src/sw.ts              Service Worker（share_target POST 受信）
web/src/lib/               db, share, importFile, pipeline, api, corrections, dictionary, diff, backup, exporter, install
web/src/lib/engines/       types, local(+whisper.worker/whisperCore), gemini, rules, server, notices, labels, index
web/src/screens/           Home, Record(4ステップ), History, Dictionary, Settings
web/vite.config.ts         manifest（share_target はここ）
scripts/                   generate-icons.mjs, verify-pwa.mjs
```

## 開発コマンド
```bash
npm ci
npm run dev:web           # 静的PWAだけで動く（/api は :8080 へプロキシ）。SWは dev では無効
npm run dev:server        # 任意：自前サーバー方式。PROVIDER=mock ALLOW_NO_AUTH=1 で外部通信なし起動可（.env を自動読込）
VITE_BASE=/soundcore-transcript-pwa/ npm run build -w @app/web   # Pages用ビルド
npm run lint && npm run typecheck && npm test && npm run build   # CI と同じ
npm run verify:pwa        # build 後。Chromium で サーバーモード + Pages(サブパス・サーバーなし)モード。VERIFY_LOCAL=1 で実Whisper(tiny)まで（要ネットワーク）
node scripts/verify-whisper.mjs <音声> tiny english   # 端末内Whisperワーカー単体の実機(ブラウザ)検証
npm run icons             # アイコン再生成（web/public/icons をコミット）
```
テスト：server 43 + web 107。実 API は絶対に呼ばない（Provider / fetch をモック）。ffmpeg が必要（サーバーテスト）。

## 設計原則
1. **4種のテキストを混ぜない**：①生文字起こし `rawTranscript`（不変。`putRecord` が上書きを拒否）②確認済み `confirmedTranscript` ③整文 `polished` ④生成物 `outputs.*`。AI は①②を上書きしない。
2. **AI は候補を出すだけ**：誤認識候補は `pending` で保存し、採用/却下/修正はユーザー操作のみ。LLM 出力の `original` が本文に無ければサーバーで破棄。
3. **コスト防止**：自動で外部 API へ送らない（受信 → 確認画面 → 「文字起こしを開始」）。段階ごとに実行中ロック、完了済みは `force` なしで再実行しない、再生成は確認ダイアログ。
4. **LLM 指示は一元管理**（`llm/prompts.ts` の `CORE_RULES`）：入力に無い事実・数値・固有名詞を創作しない、不確かなら【要確認】。新しい生成物を足すときも必ず `CORE_RULES` を前置する。
5. エラーは `AppError`（機械可読コード）→ クライアントで日本語メッセージ。スタックトレースを画面に出さない。
6. 依存は増やさない（状態管理ライブラリ・UIキット・OpenAI SDK は不採用）。

## 絶対に守る制約
- **OpenAI APIキーをフロント・バンドル・localStorage・IndexedDB・ログ・Git に入れない**。`OPENAI_API_KEY` はサーバー環境変数のみ。`.env` はコミット禁止（`.env.example` のみ）。`/api/config` はキー本体を返さない。
- **唯一の例外：Gemini の無料キー**。サーバーを持たない無料構成のため、*利用者自身が設定画面に入力した自分のキー*だけを端末の IndexedDB に保存してよい。バンドル・リポジトリ・ログ・バックアップ・URL・エラーメッセージには絶対に含めない（ヘッダ `x-goog-api-key` のみ）。Geminiの無料枠は入力が Google の製品改善に使われるため、**選択時の注意表示を消さない**。
- **課金が発生する既定動作を作らない**。既定は `local` + `rules`（無料・外部送信なし）。有料/外部送信の方式は利用者が設定で明示的に選んだときだけ。
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
- 共有 POST は **Service Worker が処理**（`sw.ts` → `lib/share.ts handleShare`）：IndexedDB `shareInbox` に保存 → **303** で `<base>?share=<id>`。`Response.redirect` は使わず `Location` ヘッダ付き 303 を返す。
- ページ側（`App.tsx handleShareParams`）は **先に URL から `share` を消し**、受信箱から取り出し → 取り込み → **成功/失敗に関わらず行を削除**。これで更新・戻る・二重共有でも再処理されない。内容指紋で重複も検知。順序を変えないこと。
- SW の `fetch` リスナー（POST /share-target）は workbox ルート登録より前。`NavigationRoute` の denylist に `/api/` と `/share-target`。`/api/*` は絶対にキャッシュしない。
- 新 SW は待機し、ユーザーが「更新する」を押したときだけ `SKIP_WAITING`（処理中の強制リロード防止）。`sw.js`・`index.html`・manifest は `no-cache`、`assets/` は immutable（`server/src/app.ts` の `setHeaders`）。
- IndexedDB のスキーマは `web/src/lib/db.ts` の `openAppDB` に**一箇所だけ**定義（SW とページで共有）。スキーマ変更時は `DB_VERSION` を上げて `upgrade` を書く。
- manifest/`share_target` を変えた後は、Android の WebAPK への反映に時間がかかる／再インストールが必要なことがある。
- Share Target は **HTTPS + インストール済み PWA + Android Chrome** でのみ動く。デスクトップでは `verify:pwa` が「フォームPOST→SW→303」を再現するだけで、共有シートそのものは再現できない。
- **未確認事項**（実機・実キーが必要）：Soundcore Work 実機の MIME/共有挙動、Android 共有シートへの表示、実 OpenAI API、`gpt-transcribe` の `keywords` 送信形式（`providers/openai.ts` に 400 時フォールバックあり）。完了報告で「動作確認済み」と書かない。

## 変更時のチェックリスト
- 新しい API/エラー → `shared` のコードと `server/src/errors.ts`（日本語メッセージ）と `web/src/lib/api.ts` を揃える。エンジンのエラーは `EngineError`（日本語メッセージ付き）で投げる。
- 新しい方式を足す → `engines/types.ts` を実装し `engines/index.ts` / `labels.ts` / `notices.ts`（プライバシー注意文）/ Settings に追加。注意文のない外部送信方式は不可。
- 端末内Whisper：onnxruntime の wasm は `web/vite.config.ts` の `ortAssets` が `<base>ort/` へ出力（CDN既定を `wasmPaths` で上書き）。依存更新で `ort-wasm-simd-threaded.asyncify.*` の名前が変わったら `ORT_FILES` と worker の `wasmPaths` を更新。`.npmrc` の `ignore-scripts=true` は `onnxruntime-node` の取得失敗回避のため（消さない）。
- DB/モデル変更 → `RecordItem`（`web/src/lib/types.ts`）、バックアップ検証（`backup.ts`）、テストを更新。
- 完了前に `lint / typecheck / test / build / verify:pwa` を実行。
