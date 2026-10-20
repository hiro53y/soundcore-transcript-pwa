import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, describeError, setAccessToken } from '../src/lib/api';

afterEach(() => {
  vi.unstubAllGlobals();
  setAccessToken('');
});

const respond = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe('APIクライアント', () => {
  it('アクセストークンをBearerで付与する（OpenAIキーは扱わない）', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => respond(200, { provider: 'mock' }));
    vi.stubGlobal('fetch', f);
    setAccessToken('tok');
    await api.config();
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });
  it('サーバーのエラー本文を日本語メッセージとして扱う', async () => {
    vi.stubGlobal('fetch', async () => respond(429, { error: { code: 'rate_limited', message: '混み合っています', retryable: true } }));
    await expect(api.config()).rejects.toMatchObject({ code: 'rate_limited', message: '混み合っています', retryable: true });
  });
  it('本文なしの401/5xxも分かりやすいメッセージ', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 401 }));
    await expect(api.config()).rejects.toMatchObject({ code: 'unauthorized' });
    vi.stubGlobal('fetch', async () => new Response('', { status: 503 }));
    await expect(api.config()).rejects.toMatchObject({ code: 'provider_error', retryable: true });
  });
  it('通信失敗は network、オフラインなら offline', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('navigator', { onLine: true });
    await expect(api.config()).rejects.toMatchObject({ code: 'network' });
    vi.stubGlobal('navigator', { onLine: false });
    await expect(api.config()).rejects.toMatchObject({ code: 'offline' });
  });
  it('describeError はスタックトレースを出さず日本語で返す', () => {
    expect(describeError(new ApiError('timeout', 'タイムアウトしました'))).toBe('タイムアウトしました');
    expect(describeError(new Error('TypeError: x is undefined at foo.js:12'))).toBe('予期しないエラーが発生しました。もう一度お試しください。');
    expect(describeError(Object.assign(new Error('q'), { name: 'QuotaExceededError' }))).toContain('保存容量');
  });
});
