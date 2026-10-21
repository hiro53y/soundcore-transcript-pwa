import { describe, expect, it } from 'vitest';
import { getTextEngine, getTranscribeEngine } from '../src/lib/engines';
import { privacyNoticeFor, textPrivacyNoticeFor } from '../src/lib/engines/notices';
import { buildBackup } from '../src/lib/backup';
import { getSettings, patchSettings } from '../src/lib/db';
import { handleShare } from '../src/lib/share';
import { DEFAULT_SETTINGS } from '../src/lib/types';

describe('エンジン選択と既定値（課金なし・サーバーなしで動く構成）', () => {
  it('既定は 端末内Whisper + ルールベース（無料・外部送信なし）', async () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ transcribeEngine: 'local', textEngine: 'rules', autoStart: false });
    const s = await getSettings();
    expect(getTranscribeEngine(s).id).toBe('local');
    expect(getTextEngine(s).id).toBe('rules');
  });
  it('設定に応じてエンジンが切り替わる', () => {
    const base = { ...DEFAULT_SETTINGS };
    expect(getTranscribeEngine({ ...base, transcribeEngine: 'gemini' }).id).toBe('gemini');
    expect(getTranscribeEngine({ ...base, transcribeEngine: 'server' }).id).toBe('server');
    expect(getTextEngine({ ...base, textEngine: 'gemini' }).id).toBe('gemini');
    expect(getTextEngine({ ...base, textEngine: 'server' }).id).toBe('server');
  });
  it('外部送信する方式には必ず注意文があり、端末内は「送信されない」と明示', () => {
    expect(privacyNoticeFor('gemini')).toMatch(/製品改善/);
    expect(privacyNoticeFor('server')).toContain('所属組織の規程や関係者の同意');
    expect(privacyNoticeFor('local')).toContain('外部へ送信されません');
    expect(textPrivacyNoticeFor('gemini')).toMatch(/製品改善/);
    expect(textPrivacyNoticeFor('rules')).toContain('外部へ送信されません');
  });
  it('Geminiキー・アクセストークンはバックアップに含まれない', async () => {
    await patchSettings({ geminiApiKey: 'AIza-SECRET', accessToken: 'TOKEN-SECRET-123', whisperModel: 'small' });
    const json = JSON.stringify(await buildBackup());
    expect(json).not.toContain('AIza-SECRET');
    expect(json).not.toContain('TOKEN-SECRET-123');
    expect(json).toContain('small');
  });
});

describe('GitHub Pages（サブパス配信）の共有受信', () => {
  it('共有POSTの303は配信パス(base)付きで戻る', async () => {
    const form = new FormData();
    form.append('audio', new File([new Uint8Array(10)], 'a.mp3', { type: 'audio/mpeg' }));
    const req = new Request('https://hiro53y.github.io/soundcore-transcript-pwa/share-target', { method: 'POST', body: form });
    const res = await handleShare(req, { putInbox: async () => undefined, now: () => 1, newId: () => 'abc' });
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe('/soundcore-transcript-pwa/?share=abc');
    const none = await handleShare(new Request('https://hiro53y.github.io/soundcore-transcript-pwa/share-target', { method: 'POST', body: new FormData() }), { putInbox: async () => undefined, now: () => 1, newId: () => 'x' });
    expect(none.headers.get('Location')).toBe('/soundcore-transcript-pwa/?share_error=nofile');
  });
});
