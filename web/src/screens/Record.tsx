import { useEffect, useMemo, useState } from 'react';
import { OUTPUT_KINDS, OUTPUT_LABELS, type Correction, type OutputKind } from '@app/shared';
import { Button, Card, DiffView, ExportBar, Notice, PrivacyNotice, ProgressBar, SubmitBar } from '../components/ui';
import { countOccurrences, decide, pendingCount } from '../lib/corrections';
import { deleteAudio, getAudio, getRecord, getSettings, putRecord } from '../lib/db';
import { getTranscribeEngine } from '../lib/engines';
import { downloadHint, isWhisperCached } from '../lib/engines/local';
import { recordToMarkdown } from '../lib/exporter';
import { formatBytes, formatDateTime, formatDuration } from '../lib/format';
import { useLive, useOnline } from '../lib/hooks';
import {
  addDictionaryCandidates,
  confirmTranscript,
  getProgress,
  isRunning,
  runGenerate,
  runPolish,
  runProofread,
  startTranscription,
  workingText,
} from '../lib/pipeline';
import type { RecordItem, StageState } from '../lib/types';

type Step = 'transcribe' | 'review' | 'polish' | 'outputs';
const STEPS: { id: Step; label: string }[] = [
  { id: 'transcribe', label: '① 文字起こし' },
  { id: 'review', label: '② 確認・校正' },
  { id: 'polish', label: '③ 整文' },
  { id: 'outputs', label: '④ 議事録等' },
];

function defaultStep(r: RecordItem): Step {
  if (r.stages.transcribe.status !== 'done') return 'transcribe';
  if (!r.confirmedTranscript) return 'review';
  if (!r.polished) return 'polish';
  return 'outputs';
}

async function patch(id: string, fn: (r: RecordItem) => void) {
  const r = await getRecord(id);
  if (!r) return;
  fn(r);
  r.updatedAt = new Date().toISOString();
  await putRecord(r);
}

export function RecordScreen({ id }: { id: string }) {
  const rec = useLive(() => getRecord(id), [id]);
  const [step, setStep] = useState<Step | undefined>();
  useEffect(() => {
    if (rec && step === undefined) setStep(defaultStep(rec));
  }, [rec, step]);
  if (!rec) return <Card>読み込み中…（見つからない場合は履歴から選び直してください）</Card>;
  const current = step ?? defaultStep(rec);
  const done = (s: Step) =>
    s === 'transcribe' ? rec.stages.transcribe.status === 'done' : s === 'review' ? !!rec.confirmedTranscript : s === 'polish' ? !!rec.polished : Object.keys(rec.outputs).length > 0;
  return (
    <div className="stack">
      <input
        className="title-input"
        aria-label="タイトル"
        value={rec.title}
        onChange={(e) => void patch(id, (r) => void (r.title = e.target.value))}
      />
      <nav className="stepper" aria-label="処理の流れ">
        {STEPS.map((s) => (
          <button key={s.id} className={`step${current === s.id ? ' active' : ''}${done(s.id) ? ' done' : ''}`} onClick={() => setStep(s.id)} aria-current={current === s.id}>
            {done(s.id) ? '✓ ' : ''}
            {s.label}
          </button>
        ))}
      </nav>
      {current === 'transcribe' && <TranscribeStep rec={rec} next={() => setStep('review')} />}
      {current === 'review' && <ReviewStep rec={rec} next={() => setStep('polish')} />}
      {current === 'polish' && <PolishStep rec={rec} next={() => setStep('outputs')} />}
      {current === 'outputs' && <OutputsStep rec={rec} />}
    </div>
  );
}

function StageError({ stage }: { stage: StageState }) {
  return stage.status === 'error' && stage.error ? <Notice kind="error">{stage.error}</Notice> : null;
}

// ---------------- ① 文字起こし ----------------
function TranscribeStep({ rec, next }: { rec: RecordItem; next: () => void }) {
  const online = useOnline();
  const hasAudio = useLive(() => getAudio(rec.id).then(Boolean), [rec.id, rec.audioDeleted]);
  const settings = useLive(getSettings, []);
  const cached = useLive(() => (settings ? isWhisperCached(settings.whisperModel) : Promise.resolve(true)), [settings?.whisperModel]);
  const blocked = settings ? getTranscribeEngine(settings).preflight?.({ durationSec: rec.durationSec, size: rec.fileSize }) : undefined;
  const progress = getProgress(rec.id);
  const running = rec.stages.transcribe.status === 'running' || isRunning(rec.id);
  const transcribed = rec.stages.transcribe.status === 'done';
  // 画面を開き直したときに、サーバー側で継続中のジョブへ自動で追従する（新規送信はしない）
  useEffect(() => {
    if (rec.jobId && rec.stages.transcribe.status === 'running' && !isRunning(rec.id)) void startTranscription(rec.id);
  }, [rec.id, rec.jobId, rec.stages.transcribe.status]);

  const ext = rec.fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '';
  return (
    <>
      <Card title="受信した音声">
        <dl className="kv">
          <dt>ファイル名</dt><dd>{rec.fileName}</dd>
          <dt>サイズ</dt><dd>{formatBytes(rec.fileSize)}</dd>
          <dt>音声の長さ</dt><dd>{formatDuration(rec.durationSec)}</dd>
          <dt>形式</dt><dd>{ext || '不明'}（{rec.durationSec !== undefined ? '再生可能・対応形式です' : '長さを取得できませんでした（送信時にサーバーで再検証します）'}）</dd>
          <dt>取り込み</dt><dd>{rec.source === 'share' ? '共有から受信' : 'ファイル選択'}／{formatDateTime(rec.createdAt)}</dd>
        </dl>
      </Card>

      {!transcribed && (
        <>
          {settings && <PrivacyNotice engine={settings.transcribeEngine} />}
          {settings?.transcribeEngine === 'local' && (
            <Notice>
              {downloadHint(settings.whisperModel, cached ?? true)}
              端末の性能によっては録音時間と同程度〜数倍の時間がかかります。処理中は<strong>画面を開いたまま</strong>にしてください（長い録音はGeminiの方が速く確実です）。
            </Notice>
          )}
          {rec.durationSec !== undefined && rec.durationSec > 3600 && settings?.transcribeEngine !== 'local' && <Notice>長い音声です。処理には時間がかかります（自動で区間に分割して処理します）。</Notice>}
          {blocked && <Notice kind="error">{blocked} <a href="#/settings">設定を開く</a></Notice>}
          <StageError stage={rec.stages.transcribe} />
          {running && <ProgressBar label={progress?.label ?? '処理中'} ratio={progress?.ratio} />}
          {!hasAudio && !rec.jobId && <Notice kind="error">この記録の音声は端末に残っていません。履歴の文字起こしは閲覧できますが、再度文字起こしするには音声ファイルを選び直してください。</Notice>}
          <SubmitBar>
            <Button kind="primary" block disabled={running || !!blocked || (settings?.transcribeEngine !== 'local' && !online) || (!hasAudio && !rec.jobId)} onClick={() => void startTranscription(rec.id)}>
              {running ? '文字起こし中…' : rec.stages.transcribe.status === 'error' ? (rec.jobId ? '失敗した区間を再試行' : '再試行') : '文字起こしを開始'}
            </Button>
            {!online && settings?.transcribeEngine !== 'local' && <p className="muted small center">オフラインです。接続後に開始できます。</p>}
          </SubmitBar>
        </>
      )}

      {transcribed && (
        <>
          <Card title="生文字起こし（音声認識の出力）">
            <p className="muted small">この内容は保持され、以降の修正・整文で上書きされません。</p>
            <div className="text-block" data-testid="raw-transcript">{rec.rawTranscript}</div>
            <ExportBar title={rec.title} text={rec.rawTranscript ?? ''} suffix="生文字起こし" />
          </Card>
          <SubmitBar>
            <Button kind="primary" block onClick={next}>誤認識を確認する</Button>
          </SubmitBar>
        </>
      )}

      {hasAudio && (
        <Card title="音声データ">
          <p className="muted small">音声は端末内に保存されています。{transcribed ? '文字起こしは完了しているため削除できます。' : ''}</p>
          <Button
            kind="danger"
            disabled={running}
            onClick={async () => {
              if (!confirm('この記録の音声ファイルを端末から削除します。文字起こし結果は残ります。よろしいですか？')) return;
              await deleteAudio(rec.id);
              await patch(rec.id, (r) => void (r.audioDeleted = true));
            }}
          >
            音声を削除
          </Button>
        </Card>
      )}
      {rec.audioDeleted && <p className="muted small">音声は削除済みです。</p>}
    </>
  );
}

// ---------------- ② 確認・校正 ----------------
const CONF_LABEL = { high: '確信度: 高', medium: '確信度: 中', low: '確信度: 低' } as const;

function CorrectionCard({ c, raw, disabled, onDecide }: { c: Correction; raw: string; disabled: boolean; onDecide: (d: Correction['decision'], finalText?: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(c.finalText ?? c.suggestion);
  const n = countOccurrences(raw, c.original);
  return (
    <li className={`correction decision-${c.decision}`}>
      <div className="correction-head">
        <span className={`badge conf-${c.confidence}`}>{CONF_LABEL[c.confidence]}</span>
        <span className="badge">{c.source === 'dictionary' ? '辞書' : 'AI'}</span>
        <span className="muted small">{n}箇所</span>
      </div>
      <div className="correction-body">
        <div><span className="label">原文</span><del>{c.original}</del></div>
        <div><span className="label">候補</span><ins>{c.suggestion}</ins></div>
        <div className="muted small"><span className="label">理由</span>{c.reason || '（理由なし）'}</div>
      </div>
      {c.decision !== 'pending' && (
        <p className="small">
          {c.decision === 'accepted' && '✓ 採用済み'}
          {c.decision === 'rejected' && '✕ 却下済み'}
          {c.decision === 'edited' && `✎ 修正して採用: 「${c.finalText}」`}
          <button className="link" disabled={disabled} onClick={() => onDecide('pending')}>取り消す</button>
        </p>
      )}
      {c.decision === 'pending' && !editing && (
        <div className="row">
          <Button kind="primary" disabled={disabled} onClick={() => onDecide('accepted')}>採用</Button>
          <Button disabled={disabled} onClick={() => onDecide('rejected')}>却下</Button>
          <Button disabled={disabled} onClick={() => setEditing(true)}>自分で修正</Button>
        </div>
      )}
      {editing && (
        <div className="stack-sm">
          <input aria-label="修正後の表記" value={text} onChange={(e) => setText(e.target.value)} />
          <div className="row">
            <Button
              kind="primary"
              disabled={!text.trim()}
              onClick={() => {
                onDecide('edited', text.trim());
                setEditing(false);
              }}
            >
              この表記で採用
            </Button>
            <Button onClick={() => setEditing(false)}>キャンセル</Button>
          </div>
        </div>
      )}
    </li>
  );
}

function ReviewStep({ rec, next }: { rec: RecordItem; next: () => void }) {
  const online = useOnline();
  const settings = useLive(getSettings, []);
  const aiProofread = settings?.textEngine !== 'rules';
  const [directEdit, setDirectEdit] = useState(false);
  const raw = rec.rawTranscript;
  const working = useMemo(() => workingText(rec), [rec]);
  const manual = rec.manualEdit !== undefined;
  if (raw === undefined) return <Notice>先に文字起こしを完了してください。</Notice>;
  const pending = pendingCount(rec.corrections);
  const setCorrections = (list: Correction[]) => patch(rec.id, (r) => void (r.corrections = list));
  const proofreadRunning = rec.stages.proofread.status === 'running';
  return (
    <>
      <Card title="誤認識の確認">
        <p className="muted small">AIや辞書が示すのは「候補」だけです。採用・却下・修正はあなたが決め、決定するまで本文は変わりません。</p>
        <div className="row">
          {aiProofread && (
            <Button kind="primary" disabled={proofreadRunning || !online || rec.stages.proofread.status === 'done'} onClick={() => void runProofread(rec.id)}>
              {proofreadRunning ? '候補を生成中…' : rec.stages.proofread.status === 'done' ? 'AI候補は生成済み' : 'AIで誤認識候補を探す'}
            </Button>
          )}
          <Button kind={aiProofread ? 'secondary' : 'primary'} onClick={() => void addDictionaryCandidates(rec.id)}>辞書から候補を追加</Button>
        </div>
        {!aiProofread && <p className="muted small">AIによる候補は、設定で整文・議事録の方式を「Google Gemini」にすると使えます。今は専門用語辞書の候補のみです（無料）。</p>}
        {proofreadRunning && <ProgressBar label={getProgress(rec.id)?.label ?? '校正候補を生成中'} />}
        <StageError stage={rec.stages.proofread} />
        {aiProofread && rec.stages.proofread.status === 'done' && (
          <button className="link" onClick={() => void runProofread(rec.id, true)} disabled={!online}>AI候補を再生成（追加料金）</button>
        )}
      </Card>

      {manual && <Notice kind="warn">全文を直接編集中のため、候補の採否は本文に反映されません。<button className="link" onClick={() => void patch(rec.id, (r) => void (r.manualEdit = undefined))}>直接編集を破棄して候補に戻す</button></Notice>}

      {rec.corrections.length === 0 ? (
        <Card><p className="muted">候補はまだありません。「AIで誤認識候補を探す」または辞書から追加できます。</p></Card>
      ) : (
        <ul className="list" aria-label="誤認識候補">
          {rec.corrections.map((c) => (
            <CorrectionCard key={c.id} c={c} raw={raw} disabled={manual} onDecide={(d, f) => void setCorrections(decide(rec.corrections, c.id, d, f))} />
          ))}
        </ul>
      )}

      <Card title="全文を直接編集">
        {!directEdit ? (
          <Button onClick={() => setDirectEdit(true)}>本文を直接編集する</Button>
        ) : (
          <>
            <textarea
              className="edit-area"
              aria-label="確認済み文字起こしの編集"
              value={working}
              onChange={(e) => void patch(rec.id, (r) => void (r.manualEdit = e.target.value))}
            />
            <p className="muted small">編集内容は「確認済み文字起こし」にのみ反映され、生文字起こしは変わりません。</p>
          </>
        )}
      </Card>

      <Card title="生文字起こし → 確認済みの差分">
        <DiffView before={raw} after={working} beforeLabel="生文字起こし" afterLabel="確認済み（予定）" />
      </Card>

      <SubmitBar>
        <Button
          kind="primary"
          block
          onClick={async () => {
            await confirmTranscript(rec.id, working);
            next();
          }}
        >
          {rec.confirmedTranscript !== undefined ? '確認済みを更新して次へ' : pending > 0 ? `この内容で確認済みにする（未判断${pending}件は変更なし）` : 'この内容で確認済みにする'}
        </Button>
      </SubmitBar>
    </>
  );
}

// ---------------- ③ 整文 ----------------
function PolishStep({ rec, next }: { rec: RecordItem; next: () => void }) {
  const online = useOnline();
  const settings = useLive(getSettings, []);
  const viaAi = settings?.textEngine !== 'rules';
  if (!rec.confirmedTranscript) return <Notice>先に「② 確認・校正」で確認済みにしてください。</Notice>;
  const running = rec.stages.polish.status === 'running';
  const stale = !!rec.polished && !!rec.confirmedAt && rec.confirmedAt > rec.polished.createdAt;
  return (
    <>
      <Card title="AI整文">
        <p className="muted small">
          {viaAi ? '意味・数値・固有名詞を変えず、言い淀みや重複を整理します。AIによる整文であり、事実として確定したものではありません。' : '言い淀み（えー・あのー等）や重複を機械的に取り除く簡易整文です（AIではありません）。'}
          元の確認済み文字起こしは保持されます。
        </p>
        <StageError stage={rec.stages.polish} />
        {running && <ProgressBar label={getProgress(rec.id)?.label ?? '整文中'} />}
        {!rec.polished && (
          <>
            {settings && <PrivacyNotice engine={settings.textEngine} />}
            <SubmitBar>
              <Button kind="primary" block disabled={running || (viaAi && !online)} onClick={() => void runPolish(rec.id)}>{running ? '整文中…' : '整文を実行'}</Button>
            </SubmitBar>
          </>
        )}
      </Card>
      {rec.polished && (
        <>
          {stale && <Notice kind="warn">確認済み文字起こしが更新されています。必要なら再生成してください。</Notice>}
          <Card title="整文（AI）">
            <div className="text-block" data-testid="polished">{rec.polished.text}</div>
            <ExportBar title={rec.title} text={rec.polished.text} suffix="整文" />
            <p className="muted small">モデル: {rec.polished.model}</p>
          </Card>
          <Card title="確認済み → 整文の差分">
            <DiffView before={rec.confirmedTranscript} after={rec.polished.text} beforeLabel="確認済み" afterLabel="整文" />
          </Card>
          <div className="row">
            <Button disabled={running || !online} onClick={() => confirm('整文を再生成します（追加のAPI料金が発生します）。よろしいですか？') && void runPolish(rec.id, true)}>整文を再生成</Button>
          </div>
          <SubmitBar>
            <Button kind="primary" block onClick={next}>議事録・要約へ</Button>
          </SubmitBar>
        </>
      )}
    </>
  );
}

// ---------------- ④ 成果物 ----------------
function OutputsStep({ rec }: { rec: RecordItem }) {
  const online = useOnline();
  const settings = useLive(getSettings, []);
  if (!rec.confirmedTranscript) return <Notice>先に「② 確認・校正」で確認済みにしてください。</Notice>;
  const viaAi = settings?.textEngine !== 'rules';
  return (
    <>
      <p className="muted small">生成物は確認済み文字起こしから作られ、それぞれ別のデータとして保存されます。{viaAi ? '入力に無い内容をAIが補うことは禁止していますが、重要事項は必ず確認してください。' : 'いまはAIを使わない簡易版です（原文の文を抜き出して整理するだけ）。より自然な議事録は、設定で「Google Gemini」を選ぶと作れます。'}</p>
      {settings && <PrivacyNotice engine={settings.textEngine} />}
      {OUTPUT_KINDS.map((k) => (
        <OutputCard key={k} rec={rec} kind={k} online={online || !viaAi} />
      ))}
      <Card title="すべてまとめてエクスポート">
        <ExportBar title={rec.title} text={recordToMarkdown(rec)} markdown={recordToMarkdown(rec)} suffix="全体" />
      </Card>
    </>
  );
}

function OutputCard({ rec, kind, online }: { rec: RecordItem; kind: OutputKind; online: boolean }) {
  const stage = rec.stages.outputs[kind];
  const out = rec.outputs[kind];
  const running = stage?.status === 'running';
  return (
    <Card title={OUTPUT_LABELS[kind]}>
      {stage && <StageError stage={stage} />}
      {running && <ProgressBar label="生成中" />}
      {out ? (
        <>
          <div className="text-block" data-testid={`out-${kind}`}>{out.text}</div>
          <ExportBar title={rec.title} text={out.text} suffix={OUTPUT_LABELS[kind]} />
          <button className="link" disabled={running || !online} onClick={() => confirm(`${OUTPUT_LABELS[kind]}を再生成します（追加のAPI料金が発生します）。よろしいですか？`) && void runGenerate(rec.id, kind, true)}>再生成</button>
        </>
      ) : (
        <Button kind="primary" disabled={running || !online} onClick={() => void runGenerate(rec.id, kind)}>{running ? '生成中…' : `${OUTPUT_LABELS[kind]}を生成`}</Button>
      )}
    </Card>
  );
}

