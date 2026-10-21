import { useEffect, useState } from 'react';
import { Button, Card, Notice, ProgressBar } from '../components/ui';
import type { ConfigResponse } from '@app/shared';
import { api, describeError, setAccessToken } from '../lib/api';
import { buildBackup, importBackup } from '../lib/backup';
import { getSettings, patchSettings } from '../lib/db';
import { TEXT_LABELS, TRANSCRIBE_LABELS } from '../lib/engines/labels';
import { testGeminiConnection } from '../lib/engines/gemini';
import { deleteWhisperCache, isWhisperCached, prefetchWhisper } from '../lib/engines/local';
import { textPrivacyNoticeFor, privacyNoticeFor } from '../lib/engines/notices';
import type { TextEngineId, TranscribeEngineId } from '../lib/engines/types';
import { ORT_WASM_MB, WHISPER_MODELS } from '../lib/engines/whisperCore';
import { downloadText } from '../lib/exporter';
import { formatBytes, formatDateTime } from '../lib/format';
import { useLive } from '../lib/hooks';
import { serverAvailable } from '../lib/serverAvailable';
import { DEFAULT_GEMINI_MODEL, type WhisperSize } from '../lib/types';

type Msg = { kind: 'ok' | 'error' | 'info'; text: string };

export function Settings() {
  const settings = useLive(getSettings, []);
  const server = useLive(serverAvailable, []);
  const [msg, setMsg] = useState<Msg>();
  const [token, setToken] = useState('');
  const [gKey, setGKey] = useState('');
  const [gModel, setGModel] = useState(DEFAULT_GEMINI_MODEL);
  const [cfg, setCfg] = useState<ConfigResponse | string>();
  const [dl, setDl] = useState<number | undefined>();
  const cached = useLive(() => (settings ? isWhisperCached(settings.whisperModel) : Promise.resolve(false)), [settings?.whisperModel, dl]);

  useEffect(() => {
    if (!settings) return;
    setToken(settings.accessToken);
    setGKey(settings.geminiApiKey);
    setGModel(settings.geminiModel);
  }, [settings]);

  if (!settings) return <Card>読み込み中…</Card>;
  const showServer = !!server || settings.transcribeEngine === 'server' || settings.textEngine === 'server';
  const tEngines: TranscribeEngineId[] = showServer ? ['local', 'gemini', 'server'] : ['local', 'gemini'];
  const xEngines: TextEngineId[] = showServer ? ['rules', 'gemini', 'server'] : ['rules', 'gemini'];
  const usesGemini = settings.transcribeEngine === 'gemini' || settings.textEngine === 'gemini';

  async function checkServer() {
    setCfg(undefined);
    try {
      setCfg(await api.config());
    } catch (e) {
      setCfg(describeError(e));
    }
  }

  return (
    <div className="stack">
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      <Card title="① 文字起こしの方式">
        {tEngines.map((id) => (
          <label key={id} className="radio">
            <input type="radio" name="tengine" checked={settings.transcribeEngine === id} onChange={() => void patchSettings({ transcribeEngine: id })} />
            <span>
              <strong>{TRANSCRIBE_LABELS[id]}</strong>
              <span className="muted small block">{privacyNoticeFor(id)}</span>
            </span>
          </label>
        ))}
      </Card>

      <Card title="② 整文・議事録・要約の方式">
        {xEngines.map((id) => (
          <label key={id} className="radio">
            <input type="radio" name="xengine" checked={settings.textEngine === id} onChange={() => void patchSettings({ textEngine: id })} />
            <span>
              <strong>{TEXT_LABELS[id]}</strong>
              <span className="muted small block">{textPrivacyNoticeFor(id)}</span>
            </span>
          </label>
        ))}
      </Card>

      {settings.transcribeEngine === 'local' && (
        <Card title="この端末内Whisperの設定">
          <label>
            モデル
            <select value={settings.whisperModel} onChange={(e) => void patchSettings({ whisperModel: e.target.value as WhisperSize })}>
              {(Object.keys(WHISPER_MODELS) as WhisperSize[]).map((k) => (
                <option key={k} value={k}>{WHISPER_MODELS[k].label}（約{WHISPER_MODELS[k].approxMb}MB）</option>
              ))}
            </select>
          </label>
          <p className="muted small">{WHISPER_MODELS[settings.whisperModel].note}。初回のみモデルと実行エンジン（約{ORT_WASM_MB}MB）をダウンロードします。ダウンロード後はオフラインでも使えます。</p>
          {'gpu' in navigator && (
            <label className="check">
              <input type="checkbox" checked={settings.whisperGpu} onChange={(e) => void patchSettings({ whisperGpu: e.target.checked })} /> WebGPUで高速化（実験的。モデルのダウンロード量が増えます。失敗時は自動で通常方式に戻ります）
            </label>
          )}
          <p className="small">状態: {cached ? '✓ ダウンロード済み' : '未ダウンロード'}</p>
          {dl !== undefined && <ProgressBar label="ダウンロード中" ratio={dl} />}
          <div className="row">
            <Button
              disabled={dl !== undefined}
              onClick={async () => {
                setDl(0);
                try {
                  await prefetchWhisper(settings.whisperModel, setDl);
                  setMsg({ kind: 'ok', text: 'ダウンロードが完了しました。' });
                } catch (e) {
                  setMsg({ kind: 'error', text: describeError(e) });
                } finally {
                  setDl(undefined);
                }
              }}
            >
              今すぐダウンロード（Wi-Fi推奨）
            </Button>
            {cached && (
              <Button kind="ghost" onClick={async () => { await deleteWhisperCache(settings.whisperModel); setDl(undefined); setMsg({ kind: 'info', text: 'モデルを削除しました。' }); }}>
                モデルを削除
              </Button>
            )}
          </div>
        </Card>
      )}

      {(usesGemini || settings.geminiApiKey) && (
        <Card title="Google Gemini（無料枠）の設定">
          <Notice kind="warn">無料枠では、送信した内容が Google の製品改善に使われる場合があります（EEA・スイス・英国を除く）。機密性の高い会議には使わないでください。課金設定は有効にしないでください（無料枠の範囲で使います）。</Notice>
          <p className="muted small">キーは Google AI Studio で自分で作成します（手順はREADME参照）。キーはこの端末にだけ保存され、バックアップやサーバーには含まれません。</p>
          <label>APIキー<input type="password" autoComplete="off" value={gKey} onChange={(e) => setGKey(e.target.value)} placeholder="AIza…" /></label>
          <label>モデル名<input value={gModel} onChange={(e) => setGModel(e.target.value)} /></label>
          <div className="row">
            <Button
              kind="primary"
              onClick={async () => {
                const next = { geminiApiKey: gKey.trim(), geminiModel: gModel.trim() || DEFAULT_GEMINI_MODEL };
                await patchSettings(next);
                try {
                  setMsg({ kind: 'ok', text: await testGeminiConnection({ apiKey: next.geminiApiKey, model: next.geminiModel }) });
                } catch (e) {
                  setMsg({ kind: 'error', text: describeError(e) });
                }
              }}
            >
              保存して接続テスト
            </Button>
          </div>
        </Card>
      )}

      {showServer && (
        <Card title="自前サーバー（上級者向け）">
          <p className="muted small">このアプリをサーバーから配信している場合のみ使えます。サーバー管理者が設定した「アクセストークン」を入力します。OpenAIのAPIキーはサーバー側にだけ保存されます。</p>
          <label>アクセストークン<input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></label>
          <div className="row">
            <Button kind="primary" onClick={async () => { await patchSettings({ accessToken: token.trim() }); setAccessToken(token.trim()); setMsg({ kind: 'ok', text: '保存しました' }); await checkServer(); }}>保存して接続確認</Button>
          </div>
          {typeof cfg === 'string' && <Notice kind="error">{cfg}</Notice>}
          {cfg && typeof cfg !== 'string' && (
            <dl className="kv">
              <dt>接続</dt><dd>OK（{cfg.provider}）</dd>
              <dt>APIキー</dt><dd>{cfg.hasApiKey ? 'サーバーに設定済み' : '未設定（サーバー管理者へ連絡）'}</dd>
              <dt>文字起こし</dt><dd>{cfg.transcribeModel}</dd>
              <dt>整文・議事録</dt><dd>{cfg.llmModel}（軽量: {cfg.llmModelLight}）</dd>
            </dl>
          )}
        </Card>
      )}

      <Card title="処理">
        <label className="check"><input type="checkbox" checked={settings.autoDeleteAudio} onChange={(e) => void patchSettings({ autoDeleteAudio: e.target.checked })} /> 文字起こし完了後に音声を端末から自動削除する</label>
        <label className="check"><input type="checkbox" checked={settings.autoStart} onChange={(e) => void patchSettings({ autoStart: e.target.checked })} /> 受信後、確認なしで文字起こしを自動開始する</label>
        <p className="muted small">自動開始は将来の拡張用です。現在は常に確認画面で「文字起こしを開始」を押す必要があります。</p>
      </Card>

      <Card title="バックアップ">
        <p className="muted small">履歴・辞書・設定をJSONで保存/復元します（音声・各種キー・トークンは含まれません）。復元は既存データを上書きせず追加します。</p>
        <div className="row">
          <Button onClick={async () => downloadText(JSON.stringify(await buildBackup(), null, 2), `backup_${new Date().toISOString().slice(0, 10)}.json`, 'application/json')}>エクスポート</Button>
          <label className="btn btn-secondary">
            インポート
            <input type="file" accept="application/json,.json" hidden data-testid="backup-input" onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                const r = await importBackup(await f.text());
                setMsg({ kind: 'ok', text: `履歴 ${r.recordsAdded}件・辞書 ${r.dictionaryAdded}件を追加しました（既存 ${r.recordsSkipped}件はスキップ）。` });
              } catch (err) {
                setMsg({ kind: 'error', text: err instanceof Error ? err.message : describeError(err) });
              }
              e.target.value = '';
            }} />
          </label>
        </div>
      </Card>

      <Card title="開発者向け">
        <label className="check"><input type="checkbox" checked={settings.devMode} onChange={(e) => void patchSettings({ devMode: e.target.checked })} /> 受信情報を表示（開発者モード）</label>
        {settings.devMode && (
          <div data-testid="dev-panel">
            {settings.lastShare ? (
              <dl className="kv">
                <dt>経路</dt><dd>{settings.lastShare.via === 'share' ? 'Android共有' : 'ファイル選択'}</dd>
                <dt>MIME type</dt><dd>{settings.lastShare.mime || '（空）'}</dd>
                <dt>ファイル名</dt><dd>{settings.lastShare.fileName}</dd>
                <dt>サイズ</dt><dd>{formatBytes(settings.lastShare.size)}</dd>
                <dt>受信時刻</dt><dd>{formatDateTime(new Date(settings.lastShare.receivedAt).toISOString())}</dd>
              </dl>
            ) : <p className="muted small">まだ受信していません。</p>}
          </div>
        )}
      </Card>
      <p className="muted small center">バージョン {__APP_VERSION__}</p>
    </div>
  );
}
