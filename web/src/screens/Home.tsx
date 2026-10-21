import { useEffect, useRef, useState } from 'react';
import { Button, Card, Notice } from '../components/ui';
import { getSettings, listRecords, patchSettings } from '../lib/db';
import { describeError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { navigate, useLive } from '../lib/hooks';
import { importAudio } from '../lib/importFile';
import { TEXT_LABELS, TRANSCRIBE_LABELS } from '../lib/engines/labels';
import { installAvailable, isStandalone, promptInstall, subscribeInstall } from '../lib/install';

export function Home({ notice }: { notice?: { kind: 'info' | 'warn' | 'error' | 'ok'; text: string } }) {
  const records = useLive(listRecords, []);
  const settings = useLive(getSettings, []);
  const input = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ kind: 'info' | 'warn' | 'error' | 'ok'; text: string } | undefined>();
  const shown = msg ?? notice;

  async function onPick(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    try {
      const res = await importAudio(f, { name: f.name, mime: f.type, source: 'picker' });
      await patchSettings({ lastShare: { fileName: f.name, mime: f.type, size: f.size, receivedAt: Date.now(), via: 'picker' } });
      if (res.kind === 'invalid') setMsg({ kind: 'error', text: res.message });
      else if (res.kind === 'duplicate') {
        setMsg({ kind: 'info', text: '同じ音声が既に取り込み済みです。既存の記録を開きます。' });
        navigate(`/r/${res.record.id}`);
      } else navigate(`/r/${res.record.id}`);
    } catch (e) {
      setMsg({ kind: 'error', text: describeError(e) });
    } finally {
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="stack">
      {shown && <Notice kind={shown.kind}>{shown.text}</Notice>}
      {settings?.transcribeEngine === 'gemini' && !settings.geminiApiKey && (
        <Notice kind="warn">
          Geminiを使うには、<a href="#/settings">設定</a>でAPIキーを入力してください。
        </Notice>
      )}
      {settings?.transcribeEngine === 'server' && !settings.accessToken && (
        <Notice kind="warn">
          自前サーバーを使うには、<a href="#/settings">設定</a>でアクセストークンを入力してください。
        </Notice>
      )}
      <InstallCard />
      <Card>
        <input ref={input} type="file" accept="audio/*,.mp3,.m4a,.wav" hidden onChange={(e) => void onPick(e.target.files)} data-testid="file-input" />
        <Button kind="primary" block className="btn-hero" onClick={() => input.current?.click()}>MP3を選択</Button>
        <p className="muted small center">または Soundcoreアプリの「音声をエクスポート」→ MP3 → 共有先でこのアプリを選ぶと、自動で取り込まれます。</p>
      </Card>
      {settings && (
        <Card title="使い方（3ステップ）">
          <ol className="steps">
            <li>Soundcoreアプリで録音を「音声をエクスポート」→ <strong>MP3</strong> を選ぶ</li>
            <li>共有先の一覧から <strong>「議事録AI」</strong> を選ぶ（出ない場合は上の「MP3を選択」でもOK）</li>
            <li>内容を確認して <strong>「文字起こしを開始」</strong> を押す。あとは画面の案内どおり</li>
          </ol>
          <p className="muted small">
            いまの設定：文字起こし＝{TRANSCRIBE_LABELS[settings.transcribeEngine]}／整文・議事録＝{TEXT_LABELS[settings.textEngine]}。 <a href="#/settings">変更する</a>
          </p>
        </Card>
      )}
      <Card title="最近の記録">
        {!records ? <p className="muted">読み込み中…</p> : records.length === 0 ? <p className="muted">まだ記録はありません。</p> : (
          <ul className="list">
            {records.slice(0, 5).map((r) => (
              <li key={r.id}>
                <a className="list-item" href={`#/r/${r.id}`}>
                  <strong>{r.title}</strong>
                  <span className="muted small">{formatDateTime(r.createdAt)} ・ {statusLabel(r)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

import type { RecordItem } from '../lib/types';

function InstallCard() {
  const [, force] = useState(0);
  useEffect(() => subscribeInstall(() => force((n) => n + 1)), []);
  if (isStandalone()) return null;
  return (
    <Card title="まず、ホーム画面に追加してください" tone="info">
      <p className="small">Soundcoreアプリの共有先にこのアプリを表示するには、<strong>ホーム画面へのインストールが必要</strong>です（無料）。</p>
      {installAvailable() ? (
        <Button kind="primary" block onClick={() => void promptInstall()}>アプリをインストール</Button>
      ) : (
        <p className="small">Chromeの右上メニュー（︙）→「<strong>アプリをインストール</strong>」または「ホーム画面に追加」を選んでください。</p>
      )}
    </Card>
  );
}

export function statusLabel(r: RecordItem): string {
  if (r.stages.transcribe.status === 'running') return '文字起こし中';
  if (r.stages.transcribe.status !== 'done') return '文字起こし前';
  if (!r.confirmedTranscript) return '確認待ち';
  if (Object.keys(r.outputs).length) return '議事録等あり';
  if (r.polished) return '整文済み';
  return '確認済み';
}
