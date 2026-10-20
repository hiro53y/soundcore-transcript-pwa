import { useState } from 'react';
import { Button, Card, Notice } from '../components/ui';
import { deleteDictionaryEntry, listDictionary, putDictionaryEntry } from '../lib/db';
import { normalizeMisrecognitions } from '../lib/dictionary';
import { useLive } from '../lib/hooks';
import type { DictionaryEntry } from '../lib/types';

const SAMPLE = ['CGL', 'GI', 'GL', 'スナウト', 'アッシュポンプ', 'コイル', '板温', '炉圧', 'テンション', 'RTH', 'SGC570'];

export function Dictionary() {
  const entries = useLive(listDictionary, []);
  const [editing, setEditing] = useState<DictionaryEntry | null>(null);
  if (!entries) return <Card>読み込み中…</Card>;
  const sorted = [...entries].sort((a, b) => a.term.localeCompare(b.term, 'ja'));
  return (
    <div className="stack">
      <Notice>登録した用語は、文字起こしと校正AIへ「参考用語」として渡されます。誤認識例を登録すると、本文に現れたとき置換候補として提示されます（自動では書き換えません）。</Notice>
      <Button kind="primary" block onClick={() => setEditing({ id: crypto.randomUUID(), term: '', misrecognitions: [] })}>用語を追加</Button>
      {editing && <EntryForm entry={editing} onClose={() => setEditing(null)} />}
      {sorted.length === 0 ? (
        <Card title="用語がまだありません">
          <p className="muted small">例: {SAMPLE.join('、')}</p>
          <Button onClick={async () => { for (const t of SAMPLE) await putDictionaryEntry({ id: crypto.randomUUID(), term: t, misrecognitions: [] }); }}>例の用語を一括登録</Button>
        </Card>
      ) : (
        <ul className="list">
          {sorted.map((e) => (
            <li key={e.id} className="card list-row">
              <div className="list-item">
                <strong>{e.term}</strong>
                {e.misrecognitions.length > 0 && <span className="muted small">誤認識: {e.misrecognitions.join('、')}</span>}
                {e.note && <span className="muted small">{e.note}</span>}
              </div>
              <Button kind="ghost" onClick={() => setEditing(e)}>編集</Button>
              <Button kind="ghost" aria-label={`${e.term}を削除`} onClick={() => void deleteDictionaryEntry(e.id)}>削除</Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EntryForm({ entry, onClose }: { entry: DictionaryEntry; onClose: () => void }) {
  const [term, setTerm] = useState(entry.term);
  const [mis, setMis] = useState(entry.misrecognitions.join('、'));
  const [note, setNote] = useState(entry.note ?? '');
  return (
    <Card title={entry.term ? '用語を編集' : '用語を追加'}>
      <div className="stack-sm">
        <label>正式表記<input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="例: CGL" /></label>
        <label>誤認識されやすい表記（、区切り）<input value={mis} onChange={(e) => setMis(e.target.value)} placeholder="例: シージーエル、CGLL" /></label>
        <label>メモ（任意）<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        <div className="row">
          <Button kind="primary" disabled={!term.trim()} onClick={async () => {
            await putDictionaryEntry({ ...entry, term: term.trim(), misrecognitions: normalizeMisrecognitions(mis), note: note.trim() || undefined });
            onClose();
          }}>保存</Button>
          <Button onClick={onClose}>キャンセル</Button>
        </div>
      </div>
    </Card>
  );
}
