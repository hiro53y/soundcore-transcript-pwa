import { useCallback, useEffect, useRef, useState } from 'react';
import { registerSW } from 'virtual:pwa-register';
import { Button, Notice } from './components/ui';
import { setAccessToken } from './lib/api';
import { getSettings, listRecords, patchSettings } from './lib/db';
import { navigate, useOnline, useRoute } from './lib/hooks';
import { consumeShares } from './lib/importFile';
import { recoverStaleStages } from './lib/pipeline';
import { Dictionary } from './screens/Dictionary';
import { History } from './screens/History';
import { Home } from './screens/Home';
import { RecordScreen } from './screens/Record';
import { Settings } from './screens/Settings';

type Banner = { kind: 'info' | 'warn' | 'error' | 'ok'; text: string };

const SHARE_ERRORS: Record<string, string> = {
  nofile: '共有データに音声ファイルが含まれていませんでした。Soundcoreアプリで「音声をエクスポート」→「MP3」を選んで共有してください。',
  failed: '共有データの受信に失敗しました。もう一度共有するか、ホームの「MP3を選択」からファイルを選んでください。',
  nosw: 'アプリの準備が完了する前に共有されました。一度アプリを開いてから、もう一度共有するか「MP3を選択」を使ってください。',
};

/** `/?share=<id>` / `/?share_error=` を一度だけ処理し、URLを整える（更新・戻るで再処理されない）。 */
async function handleShareParams(): Promise<Banner | undefined> {
  const params = new URLSearchParams(window.location.search);
  const ids = params.getAll('share');
  const err = params.get('share_error');
  if (!ids.length && !err) return undefined;
  const clean = () => window.history.replaceState(null, '', `${window.location.pathname}${window.location.hash || '#/'}`);
  if (err) {
    clean();
    return { kind: 'error', text: SHARE_ERRORS[err] ?? SHARE_ERRORS.failed! };
  }
  clean(); // 先にURLから消す: 以降は再読み込みしても再処理されない
  try {
    const outcomes = await consumeShares(ids);
    const first = outcomes[0];
    if (!first) return undefined;
    if (first.meta) {
      await patchSettings({ lastShare: { fileName: first.meta.name, mime: first.meta.mime, size: first.meta.size, receivedAt: first.meta.receivedAt, via: 'share' } });
    }
    const r = first.result;
    if (r.kind === 'created') {
      navigate(`/r/${r.record.id}`);
      return undefined;
    }
    if (r.kind === 'duplicate') {
      navigate(`/r/${r.record.id}`);
      return { kind: 'info', text: '同じ音声が既に取り込み済みのため、既存の記録を開きました（二重に登録していません）。' };
    }
    if (r.kind === 'invalid') return { kind: 'error', text: r.message };
    return { kind: 'info', text: 'この共有は既に取り込み済みか、保持期限（24時間）を過ぎています。履歴を確認するか、もう一度共有してください。' };
  } catch (e) {
    console.error('share consume failed', e);
    return { kind: 'error', text: '共有データの取り込みに失敗しました。端末の空き容量を確認し、もう一度お試しください。' };
  }
}

export function App() {
  const route = useRoute();
  const online = useOnline();
  const [notice, setNotice] = useState<Banner>();
  const [update, setUpdate] = useState<(() => void) | null>(null);
  const started = useRef(false);

  const init = useCallback(async () => {
    if (started.current) return; // StrictModeでの二重実行防止
    started.current = true;
    const settings = await getSettings();
    setAccessToken(settings.accessToken);
    await recoverStaleStages(await listRecords());
    const n = await handleShareParams();
    if (n) setNotice(n);
  }, []);

  useEffect(() => {
    void init();
    const updateSW = registerSW({ onNeedRefresh: () => setUpdate(() => () => void updateSW(true)) });
  }, [init]);

  const page = route[0] ?? '';
  let body;
  if (page === 'r' && route[1]) body = <RecordScreen id={route[1]} key={route[1]} />;
  else if (page === 'history') body = <History />;
  else if (page === 'dictionary') body = <Dictionary />;
  else if (page === 'settings') body = <Settings />;
  else body = <Home notice={notice} />;

  const titles: Record<string, string> = { '': 'AI文字起こし・議事録', r: '記録', history: '履歴', dictionary: '専門用語辞書', settings: '設定' };
  return (
    <div className="app">
      <header className="app-header">
        {page !== '' && <button className="back" aria-label="ホームへ戻る" onClick={() => navigate('/')}>←</button>}
        <h1>{titles[page] ?? 'AI文字起こし・議事録'}</h1>
      </header>
      {!online && <Notice kind="warn">オフラインです。履歴の閲覧はできますが、文字起こし・整文などの処理は接続後に行えます。</Notice>}
      {update && (
        <Notice kind="info">
          新しいバージョンがあります。 <Button kind="primary" onClick={update}>更新する</Button>
        </Notice>
      )}
      {page !== '' && notice && <Notice kind={notice.kind}>{notice.text}</Notice>}
      <main>{body}</main>
      <nav className="tabbar" aria-label="メインメニュー">
        <a href="#/" aria-current={page === '' ? 'page' : undefined}>ホーム</a>
        <a href="#/history" aria-current={page === 'history' ? 'page' : undefined}>履歴</a>
        <a href="#/dictionary" aria-current={page === 'dictionary' ? 'page' : undefined}>辞書</a>
        <a href="#/settings" aria-current={page === 'settings' ? 'page' : undefined}>設定</a>
      </nav>
    </div>
  );
}
