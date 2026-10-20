import { OUTPUT_LABELS } from '@app/shared';
import type { RecordItem } from './types';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 権限がない等のフォールバック
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      ta.remove();
    }
  }
}

export function safeFileName(title: string): string {
  const cleaned = [...title].map((ch) => (ch.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(ch) ? '_' : ch)).join('');
  return cleaned.trim().slice(0, 60) || 'transcript';
}

export function downloadText(text: string, fileName: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export const canShare = (): boolean => typeof navigator !== 'undefined' && typeof navigator.share === 'function';

export async function shareText(title: string, text: string): Promise<boolean> {
  try {
    await navigator.share({ title, text });
    return true;
  } catch {
    return false; // キャンセルを含む
  }
}

/** Markdown文書（全成果物 + 元データ）を生成。生/確認済み/整文/AI生成物を見出しで明確に区別する。 */
export function recordToMarkdown(rec: RecordItem): string {
  const out: string[] = [`# ${rec.title}`, '', `- 元ファイル: ${rec.fileName}`, `- 処理日時: ${new Date(rec.createdAt).toLocaleString('ja-JP')}`, ''];
  if (rec.outputs.minutes) out.push('## 議事録（AI生成）', '', rec.outputs.minutes.text, '');
  for (const k of ['summary', 'bullets', 'decisions', 'todos', 'script'] as const) {
    const o = rec.outputs[k];
    if (o) out.push(`## ${OUTPUT_LABELS[k]}（AI生成）`, '', o.text, '');
  }
  if (rec.polished) out.push('## 整文（AI整文）', '', rec.polished.text, '');
  if (rec.confirmedTranscript) out.push('## 確認済み文字起こし', '', rec.confirmedTranscript, '');
  if (rec.rawTranscript) out.push('## 生文字起こし（音声認識の出力）', '', rec.rawTranscript, '');
  out.push('---', '※ AI生成・AI整文には誤りが含まれる可能性があります。重要事項は元の確認済み文字起こしと照合してください。');
  return out.join('\n');
}
