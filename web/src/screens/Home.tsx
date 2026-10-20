import { useRef, useState } from 'react';
import { Button, Card, Notice } from '../components/ui';
import { getSettings, listRecords, patchSettings } from '../lib/db';
import { describeError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { navigate, useLive } from '../lib/hooks';
import { importAudio } from '../lib/importFile';

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
      {settings && !settings.accessToken && (
        <Notice kind="warn">
          初回設定: <a href="#/settings">設定</a>でアクセストークン（サーバー管理者が決めた合言葉）を入力してください。
        </Notice>
      )}
      <Card>
        <input ref={input} type="file" accept="audio/*,.mp3,.m4a,.wav" hidden onChange={(e) => void onPick(e.target.files)} data-testid="file-input" />
        <Button kind="primary" block className="btn-hero" onClick={() => input.current?.click()}>MP3を選択</Button>
        <p className="muted small center">または Soundcoreアプリの「音声をエクスポート」→ MP3 → 共有先でこのアプリを選ぶと、自動で取り込まれます。</p>
      </Card>
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
export function statusLabel(r: RecordItem): string {
  if (r.stages.transcribe.status === 'running') return '文字起こし中';
  if (r.stages.transcribe.status !== 'done') return '文字起こし前';
  if (!r.confirmedTranscript) return '確認待ち';
  if (Object.keys(r.outputs).length) return '議事録等あり';
  if (r.polished) return '整文済み';
  return '確認済み';
}
