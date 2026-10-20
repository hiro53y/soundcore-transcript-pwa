import type { ReactNode } from 'react';
import { diffStats, diffText } from '../lib/diff';
import { useMemo, useState } from 'react';
import { canShare, copyText, downloadText, safeFileName, shareText } from '../lib/exporter';

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement> & { kind?: 'primary' | 'secondary' | 'danger' | 'ghost'; block?: boolean }) {
  const { kind = 'secondary', block, className = '', ...rest } = props;
  return <button {...rest} className={`btn btn-${kind}${block ? ' btn-block' : ''} ${className}`} />;
}

export function Card({ title, children, tone }: { title?: ReactNode; children: ReactNode; tone?: 'warn' | 'info' | 'error' }) {
  return (
    <section className={`card${tone ? ` card-${tone}` : ''}`}>
      {title && <h2 className="card-title">{title}</h2>}
      {children}
    </section>
  );
}

export function Notice({ kind = 'info', children }: { kind?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode }) {
  return (
    <div className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function ProgressBar({ label, ratio }: { label: string; ratio?: number }) {
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuenow={ratio === undefined ? undefined : Math.round(ratio * 100)}>
      <div className="progress-label">{label}{ratio !== undefined ? `（${Math.round(ratio * 100)}%）` : ''}</div>
      <div className="progress-track">
        <div className={`progress-fill${ratio === undefined ? ' indeterminate' : ''}`} style={ratio === undefined ? undefined : { width: `${Math.round(ratio * 100)}%` }} />
      </div>
    </div>
  );
}

/** 外部AIへの送信前に必ず表示する注意文。 */
export function PrivacyNotice() {
  return (
    <Notice kind="warn">
      外部AIサービスへ音声を送信します。利用する音声について、所属組織の規程や関係者の同意等を確認してください。
    </Notice>
  );
}

export function SubmitBar({ children }: { children: ReactNode }) {
  return <div className="submit-bar">{children}</div>;
}

export function DiffView({ before, after, beforeLabel, afterLabel }: { before: string; after: string; beforeLabel: string; afterLabel: string }) {
  const parts = useMemo(() => diffText(before, after), [before, after]);
  const stats = diffStats(parts);
  if (before === after) return <Notice>{beforeLabel}と{afterLabel}に違いはありません。</Notice>;
  return (
    <div>
      <p className="muted small">
        {beforeLabel} → {afterLabel}：<span className="diff-del">削除 {stats.removed}文字</span> / <span className="diff-add">追加 {stats.added}文字</span>
      </p>
      <div className="text-block diff" data-testid="diff">
        {parts.map((p, i) =>
          p.kind === 'same' ? <span key={i}>{p.text}</span> : p.kind === 'add' ? <ins key={i} className="diff-add">{p.text}</ins> : <del key={i} className="diff-del">{p.text}</del>,
        )}
      </div>
    </div>
  );
}

export function ExportBar({ title, text, markdown, suffix }: { title: string; text: string; markdown?: string; suffix: string }) {
  const [msg, setMsg] = useState('');
  const flash = (m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(''), 2000);
  };
  const base = `${safeFileName(title)}_${suffix}`;
  return (
    <div className="export-bar">
      <Button onClick={async () => flash((await copyText(text)) ? 'コピーしました' : 'コピーできませんでした')}>全文コピー</Button>
      <Button onClick={async () => flash((await copyText(markdown ?? text)) ? 'Markdownをコピーしました' : 'コピーできませんでした')}>Markdownコピー</Button>
      <Button onClick={() => downloadText(text, `${base}.txt`, 'text/plain')}>TXT保存</Button>
      <Button onClick={() => downloadText(markdown ?? text, `${base}.md`, 'text/markdown')}>MD保存</Button>
      {canShare() && <Button onClick={() => void shareText(title, text)}>共有</Button>}
      {msg && <span className="flash" role="status">{msg}</span>}
    </div>
  );
}
