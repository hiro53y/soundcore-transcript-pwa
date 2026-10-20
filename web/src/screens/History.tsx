import { useState } from 'react';
import { Button, Card } from '../components/ui';
import { deleteRecord, listRecords } from '../lib/db';
import { formatDateTime } from '../lib/format';
import { useLive } from '../lib/hooks';
import { statusLabel } from './Home';

export function History() {
  const records = useLive(listRecords, []);
  const [q, setQ] = useState('');
  if (!records) return <Card>読み込み中…</Card>;
  const query = q.trim().toLowerCase();
  const list = query
    ? records.filter((r) => [r.title, r.fileName, r.confirmedTranscript, r.polished?.text, r.rawTranscript].some((t) => t?.toLowerCase().includes(query)))
    : records;
  return (
    <div className="stack">
      <input type="search" placeholder="タイトル・本文を検索" aria-label="検索" value={q} onChange={(e) => setQ(e.target.value)} />
      {list.length === 0 ? <Card><p className="muted">{records.length ? '該当する記録がありません。' : 'まだ記録はありません。'}</p></Card> : (
        <ul className="list">
          {list.map((r) => (
            <li key={r.id} className="card list-row">
              <a className="list-item" href={`#/r/${r.id}`}>
                <strong>{r.title}</strong>
                <span className="muted small">{r.fileName}</span>
                <span className="muted small">{formatDateTime(r.createdAt)} ・ {statusLabel(r)}{r.audioDeleted ? ' ・ 音声削除済み' : ''}</span>
              </a>
              <Button kind="ghost" aria-label={`${r.title}を削除`} onClick={() => confirm(`「${r.title}」の記録（文字起こし・整文・議事録）を削除します。元に戻せません。`) && void deleteRecord(r.id)}>削除</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
