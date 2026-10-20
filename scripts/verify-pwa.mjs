// ビルド済みPWAを実ブラウザ(Chromium)で検証する: manifest / Service Worker / share_target(POST→303) / オフライン / モックでの全工程。
// 事前に `npm run build` が必要。外部通信なし（PROVIDER=mock）。
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const PORT = 18080;
const BASE = `http://localhost:${PORT}`;
const TOKEN = 'verify-token-123456';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const chromePath = [process.env.CHROMIUM_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((p) => p && existsSync(p) && !p.endsWith('/chromium') ) ?? undefined;

const dir = mkdtempSync(path.join(os.tmpdir(), 'verify-pwa-'));
const mp3 = path.join(dir, 'tone.mp3');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-b:a', '32k', mp3]);

const server = spawn('node', ['server/dist/index.js'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', PROVIDER: 'mock', APP_ACCESS_TOKEN: TOKEN, WEB_DIST: path.resolve('web/dist') },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const stop = () => server.kill('SIGTERM');
process.on('exit', stop);

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

try {
  await waitUp();

  // ---- manifest / ヘッダ ----
  const html = await (await fetch(BASE)).text();
  check('index.html が manifest を参照', html.includes('rel="manifest"'));
  const mres = await fetch(`${BASE}/manifest.webmanifest`);
  const m = await mres.json();
  check('manifest: standalone / 日本語 / start_url', m.display === 'standalone' && m.lang === 'ja' && m.start_url === '/' && !!m.name && !!m.short_name);
  const st = m.share_target;
  check('manifest: share_target は POST + multipart/form-data', st?.method === 'POST' && st?.enctype === 'multipart/form-data' && st?.action === '/share-target');
  const accept = st?.params?.files?.[0]?.accept ?? [];
  check('manifest: share_target が audio/mpeg, audio/mp3, audio/*, .mp3 を受け付ける', ['audio/mpeg', 'audio/mp3', 'audio/*', '.mp3'].every((a) => accept.includes(a)), accept.join(','));
  const sizes = m.icons.map((i) => i.sizes);
  check('manifest: 192/512 と maskable アイコン', sizes.includes('192x192') && sizes.includes('512x512') && m.icons.some((i) => i.purpose === 'maskable'));
  let iconsOk = true;
  for (const i of m.icons) iconsOk &&= (await fetch(BASE + i.src)).headers.get('content-type')?.includes('image/png');
  check('アイコン画像が取得できる', !!iconsOk);
  check('sw.js / index.html は no-cache（更新時の不整合防止）', (await fetch(`${BASE}/sw.js`)).headers.get('cache-control') === 'no-cache' && (await fetch(BASE)).headers.get('cache-control') === 'no-cache');
  const assetPath = html.match(/\/assets\/[^"]+\.js/)?.[0];
  check('ハッシュ付きassetは長期キャッシュ', !!assetPath && (await fetch(BASE + assetPath)).headers.get('cache-control')?.includes('immutable') === true);
  const fb = await fetch(`${BASE}/share-target`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'multipart/form-data; boundary=x' }, body: '--x--' });
  check('SW未制御の /share-target POST は 303 で案内へ', fb.status === 303 && fb.headers.get('location') === '/?share_error=nosw');
  const noauth = await fetch(`${BASE}/api/config`);
  check('APIはトークン無しで401', noauth.status === 401);

  // ---- ブラウザ ----
  const browser = await chromium.launch({ executablePath: chromePath, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, locale: 'ja-JP' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.waitForSelector('text=MP3を選択');
  const ready = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready;
    for (let i = 0; i < 50 && reg.active?.state !== 'activated'; i++) await new Promise((r) => setTimeout(r, 100));
    return reg.active?.state === 'activated';
  });
  check('Service Worker が登録・有効化される', ready);
  await page.reload();
  check('リロード後にSWが制御している', await page.evaluate(() => !!navigator.serviceWorker.controller));
  const cacheKeys = await page.evaluate(async () => (await caches.keys()).length);
  check('アプリシェルがプリキャッシュされる', cacheKeys > 0);

  // 設定: アクセストークン
  await page.goto(`${BASE}/#/settings`);
  await page.fill('input[type=password]', TOKEN);
  await page.click('text=保存して接続確認');
  await page.waitForSelector('text=OK（mock）');
  check('設定画面でトークン保存・接続確認', true);
  await page.goto(`${BASE}/#/`);

  // ---- 共有シミュレーション: フォームPOST（ナビゲーション）をSWが処理 ----
  const bytes = [...readFileSync(mp3)];
  await page.evaluate(async (arr) => {
    const f = new File([new Uint8Array(arr)], 'Soundcore_2026-10-20.mp3', { type: 'audio/mpeg' });
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/share-target';
    form.enctype = 'multipart/form-data';
    const input = document.createElement('input');
    input.type = 'file';
    input.name = 'audio';
    const dt = new DataTransfer();
    dt.items.add(f);
    input.files = dt.files;
    form.appendChild(input);
    document.body.appendChild(form);
    form.submit();
  }, bytes);
  await page.waitForSelector('text=Soundcore_2026-10-20.mp3');
  const url = page.url();
  check('共有POST→SW→303→アプリ画面（記録の確認画面）へ遷移', url.includes('#/r/') && !url.includes('share='), url);
  check('確認画面に「文字起こしを開始」があり、自動送信されない', await page.isVisible('button:has-text("文字起こしを開始")'));
  check('外部AI送信の注意文を表示', await page.isVisible('text=外部AIサービスへ音声を送信します'));
  await page.reload();
  await page.waitForSelector('text=Soundcore_2026-10-20.mp3');
  const recCount = await page.evaluate(
    () => new Promise((res) => {
      const r = indexedDB.open('soundcore-transcript');
      r.onsuccess = () => {
        const tx = r.result.transaction(['records', 'shareInbox'], 'readonly');
        const a = tx.objectStore('records').count();
        const b = tx.objectStore('shareInbox').count();
        tx.oncomplete = () => res([a.result, b.result]);
      };
    }),
  );
  check('再読み込みしても二重登録されず、受信箱は空', recCount[0] === 1 && recCount[1] === 0, JSON.stringify(recCount));

  // ---- 全工程（モックProvider） ----
  await page.click('button:has-text("文字起こしを開始")');
  await page.waitForSelector('[data-testid=raw-transcript]', { timeout: 30000 });
  const raw = await page.textContent('[data-testid=raw-transcript]');
  check('文字起こし完了（生文字起こしを表示）', raw.includes('モックの文字起こし'));
  await page.click('button:has-text("誤認識を確認する")');
  await page.click('button:has-text("AIで誤認識候補を探す")');
  await page.waitForSelector('button:has-text("採用")', { timeout: 15000 });
  check('誤認識候補（原文/候補/理由/確信度）を表示', (await page.isVisible('text=足ポンプ')) && (await page.isVisible('text=アッシュポンプ')) && (await page.isVisible('text=確信度')));
  await page.click('button:has-text("採用") >> nth=0');
  await page.click('button:has-text("確認済みにする")');
  await page.waitForSelector('button:has-text("整文を実行")');
  await page.click('button:has-text("整文を実行")');
  await page.waitForSelector('[data-testid=polished]', { timeout: 15000 });
  check('整文を生成し、差分が表示される', await page.isVisible('[data-testid=diff]'));
  await page.click('button:has-text("議事録・要約へ")');
  await page.click('button:has-text("議事録を生成")');
  await page.waitForSelector('[data-testid=out-minutes]', { timeout: 15000 });
  check('議事録を生成', (await page.textContent('[data-testid=out-minutes]')).includes('モック'));
  const stored = await page.evaluate(
    () => new Promise((res) => {
      const r = indexedDB.open('soundcore-transcript');
      r.onsuccess = () => {
        const q = r.result.transaction('records').objectStore('records').getAll();
        q.onsuccess = () => res(q.result[0]);
      };
    }),
  );
  check('生/確認済み/整文/議事録が別データで保存', !!stored.rawTranscript && !!stored.confirmedTranscript && !!stored.polished && !!stored.outputs.minutes && stored.rawTranscript !== stored.confirmedTranscript, '');
  check('音声が文字起こし後に自動削除される', stored.audioDeleted === true);
  const leftover = await (await fetch(`${BASE}/api/health`)).json();
  check('サーバー起動中（一時ファイル掃除はユニットテストで検証）', leftover.ok === true);

  // ---- オフライン ----
  await ctx.setOffline(true);
  await page.goto(`${BASE}/#/history`);
  await page.reload();
  await page.waitForSelector('text=履歴');
  check('オフラインでもアプリシェルと履歴が表示される', await page.isVisible('text=Soundcore_2026-10-20') || (await page.isVisible('text=オフラインです')));
  await ctx.setOffline(false);
  check('ページ内JavaScriptエラーなし', errors.length === 0, errors.join(' | '));
  await browser.close();
} catch (e) {
  check('検証スクリプトが最後まで完走', false, String(e?.stack ?? e));
} finally {
  stop();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
