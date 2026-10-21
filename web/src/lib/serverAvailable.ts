/** 自前サーバー(self-host)方式が使えるか。サーバーが同じオリジンの `/api` を配信している場合のみ true。 */
export async function serverAvailable(): Promise<boolean> {
  if (import.meta.env.BASE_URL !== '/') return false; // GitHub Pages 等の静的配信
  try {
    const r = await fetch('/api/health');
    return r.ok && ((await r.json()) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}
