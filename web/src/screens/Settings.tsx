import { useEffect, useState } from 'react';
import type { ConfigResponse } from '@app/shared';
import { Button, Card, Notice } from '../components/ui';
import { api, describeError, setAccessToken } from '../lib/api';
import { buildBackup, importBackup } from '../lib/backup';
import { getSettings, patchSettings } from '../lib/db';
import { downloadText } from '../lib/exporter';
import { formatBytes, formatDateTime } from '../lib/format';
import { useLive } from '../lib/hooks';

export function Settings() {
  const settings = useLive(getSettings, []);
  const [token, setToken] = useState('');
  const [cfg, setCfg] = useState<ConfigResponse | string>();
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string }>();

  useEffect(() => {
    if (settings) setToken(settings.accessToken);
  }, [settings]);

  async function check() {
    setCfg(undefined);
    try {
      setCfg(await api.config());
    } catch (e) {
      setCfg(describeError(e));
    }
  }

  if (!settings) return <Card>読み込み中…</Card>;
  return (
    <div className="stack">
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <Card title="サーバー接続">
        <p className="muted small">サーバー管理者が設定した「アクセストークン」を入力します。OpenAIのAPIキーはサーバー側にのみ保存され、この端末には保存されません。</p>
        <label>アクセストークン<input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} /></label>
        <div className="row">
          <Button kind="primary" onClick={async () => { await patchSettings({ accessToken: token.trim() }); setAccessToken(token.trim()); setMsg({ kind: 'ok', text: '保存しました' }); await check(); }}>保存して接続確認</Button>
        </div>
        {typeof cfg === 'string' && <Notice kind="error">{cfg}</Notice>}
        {cfg && typeof cfg !== 'string' && (
          <dl className="kv">
            <dt>接続</dt><dd>OK（{cfg.provider}）</dd>
            <dt>APIキー</dt><dd>{cfg.hasApiKey ? 'サーバーに設定済み' : '未設定（サーバー管理者へ連絡）'}</dd>
            <dt>文字起こしモデル</dt><dd>{cfg.transcribeModel}</dd>
            <dt>整文・議事録モデル</dt><dd>{cfg.llmModel}（軽量: {cfg.llmModelLight}）</dd>
            <dt>上限</dt><dd>{cfg.maxUploadMb}MB / {cfg.maxDurationMin}分</dd>
          </dl>
        )}
      </Card>

      <Card title="処理">
        <label className="check"><input type="checkbox" checked={settings.autoDeleteAudio} onChange={(e) => void patchSettings({ autoDeleteAudio: e.target.checked })} /> 文字起こし完了後に音声を端末から自動削除する</label>
        <label className="check"><input type="checkbox" checked={settings.autoStart} onChange={(e) => void patchSettings({ autoStart: e.target.checked })} /> 受信後、確認なしで文字起こしを自動開始する（誤共有でもAPI料金が発生します）</label>
        <p className="muted small">自動開始は将来の拡張用です。現在は常に確認画面で「文字起こしを開始」を押す必要があります。</p>
      </Card>

      <Card title="バックアップ">
        <p className="muted small">履歴・辞書・設定をJSONで保存/復元します（音声・アクセストークンは含まれません）。復元は既存データを上書きせず追加します。</p>
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
