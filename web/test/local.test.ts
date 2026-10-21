import { describe, expect, it, vi } from 'vitest';
import { localTranscribeEngine, prefetchWhisper, downloadHint, type LocalDeps } from '../src/lib/engines/local';
import { EngineError } from '../src/lib/engines/types';
import { LOCAL_MAX_SEC, SAMPLE_RATE, cleanChunks, findQuietCut, formatChunks, isSilent, planSegments, type WorkerIn, type WorkerLike, type WorkerOut } from '../src/lib/engines/whisperCore';

const tone = (sec: number, amp = 0.3) => Float32Array.from({ length: Math.floor(sec * SAMPLE_RATE) }, (_, i) => amp * Math.sin(i / 20));

describe('端末内Whisperの純関数', () => {
  it('静かな点を探して区間を切る（発話の途中で切らない）', () => {
    const a = tone(20);
    // 9.5〜10.0秒を無音にする
    a.fill(0, Math.floor(9.5 * SAMPLE_RATE), Math.floor(10 * SAMPLE_RATE));
    const cut = findQuietCut(a, 11, 3) / SAMPLE_RATE;
    expect(cut).toBeGreaterThanOrEqual(9.4);
    expect(cut).toBeLessThanOrEqual(10.1);
  });
  it('区間は連続・全域をカバーする', () => {
    const a = tone(400);
    const segs = planSegments(a);
    expect(segs.length).toBeGreaterThan(1);
    expect(segs[0]![0]).toBe(0);
    expect(segs.at(-1)![1]).toBe(a.length);
    for (let i = 1; i < segs.length; i++) expect(segs[i]![0]).toBe(segs[i - 1]![1]);
    expect(planSegments(tone(100))).toHaveLength(1);
  });
  it('無音判定（Whisperの幻覚対策）', () => {
    expect(isSilent(new Float32Array(16000))).toBe(true);
    expect(isSilent(tone(1))).toBe(false);
    expect(isSilent(new Float32Array(0))).toBe(true);
  });
  it('同じ文の3回以上の連続（ループ）は1つにまとめ、空文は捨てる', () => {
    const c = (text: string, s: number) => ({ start: s, end: s + 1, text });
    const out = cleanChunks([c('ご視聴ありがとうございました', 0), c('ご視聴ありがとうございました', 1), c('ご視聴ありがとうございました', 2), c('ご視聴ありがとうございました', 3), c('  ', 4), c('別の文', 5)]);
    expect(out.map((x) => x.text)).toEqual(['ご視聴ありがとうございました', 'ご視聴ありがとうございました', '別の文']);
  });
  it('約1分ごとに [hh:mm:ss] 見出しを付ける', () => {
    const t = formatChunks([{ start: 0, end: 5, text: 'あ' }, { start: 30, end: 40, text: 'い' }, { start: 65, end: 70, text: 'う' }]);
    expect(t).toBe('[00:00:00]\nあい\n\n[00:01:05]\nう');
  });
  it('初回DLの目安は未取得のときだけ表示', () => {
    expect(downloadHint('base', false)).toContain('77MB');
    expect(downloadHint('base', true)).toBe('');
  });
});

/** メッセージプロトコルを模したフェイクWorker（実モデルは動かさない）。 */
function fakeWorker(opts: { fail?: 'init' | 'run' | 'crash'; textFor?: (offsetSec: number) => string } = {}) {
  const sent: WorkerIn[] = [];
  const w: WorkerLike & { terminated: boolean } = {
    terminated: false,
    onmessage: null,
    onerror: null,
    terminate() {
      w.terminated = true;
    },
    postMessage(msg) {
      sent.push(msg);
      const reply = (d: WorkerOut) => queueMicrotask(() => w.onmessage?.({ data: d }));
      if (msg.type === 'init') {
        if (opts.fail === 'init') return reply({ type: 'error', message: 'Failed to fetch model' });
        reply({ type: 'download', ratio: 0.5 });
        reply({ type: 'ready', device: 'wasm' });
      } else {
        if (opts.fail === 'run') return reply({ type: 'error', message: 'out of memory' });
        if (opts.fail === 'crash') return void queueMicrotask(() => w.onerror?.({ message: 'boom' }));
        reply({ type: 'result', id: msg.id, chunks: [{ start: msg.offsetSec, end: msg.offsetSec + 5, text: opts.textFor?.(msg.offsetSec) ?? `区間${msg.id}` }] });
      }
    },
  };
  return { w, sent };
}
const deps = (w: WorkerLike, audio: Float32Array): LocalDeps => ({ createWorker: () => w, decode: async () => audio, basePath: '/', useGpu: false });
const input = (onProgress = vi.fn()) => ({ recordId: 'r', blob: new Blob(['x']), onProgress });

describe('端末内エンジン（フェイクWorker）', () => {
  it('区間ごとに処理し、進捗を出し、結果を時刻見出し付きで結合してWorkerを終了する', async () => {
    const { w, sent } = fakeWorker();
    const progress = vi.fn();
    const text = await localTranscribeEngine('base', deps(w, tone(400))).transcribe(input(progress));
    const runs = sent.filter((m) => m.type === 'run');
    expect(runs.length).toBe(3);
    expect(sent[0]).toMatchObject({ type: 'init', modelId: 'onnx-community/whisper-base', wasmBase: '/' });
    expect(text).toContain('[00:00:00]');
    expect(text.indexOf('区間0')).toBeLessThan(text.indexOf('区間2'));
    expect(progress.mock.calls.some(([p]) => /1\/3区間/.test(p.label))).toBe(true);
    expect(progress.mock.calls.some(([p]) => /ダウンロード/.test(p.label) && p.ratio === 0.5)).toBe(true);
    expect(w.terminated).toBe(true);
  });
  it('無音の区間はモデルに渡さない', async () => {
    const a = new Float32Array(400 * SAMPLE_RATE);
    a.set(tone(150), 0); // 先頭のみ発話
    const { w, sent } = fakeWorker();
    await localTranscribeEngine('tiny', deps(w, a)).transcribe(input());
    expect(sent.filter((m) => m.type === 'run').length).toBeLessThan(3);
  });
  it('全編無音なら、その旨を返す（幻覚文を出さない）', async () => {
    const { w } = fakeWorker();
    expect(await localTranscribeEngine('tiny', deps(w, new Float32Array(10 * SAMPLE_RATE))).transcribe(input())).toContain('検出できませんでした');
  });
  it('モデル取得失敗・実行失敗・クラッシュを日本語で通知し、Workerを必ず終了', async () => {
    for (const [fail, re] of [['init', /ダウンロードまたは読み込みに失敗/], ['run', /メモリ不足/], ['crash', /エラーが発生しました/]] as const) {
      const { w } = fakeWorker({ fail });
      await expect(localTranscribeEngine('base', deps(w, tone(10))).transcribe(input())).rejects.toThrow(re);
      expect(w.terminated).toBe(true);
    }
  });
  it('45分超は開始前に案内（preflight）、デコード失敗は日本語エラー', async () => {
    const e = localTranscribeEngine('base', deps(fakeWorker().w, tone(1)));
    expect(e.preflight?.({ durationSec: LOCAL_MAX_SEC + 1 })).toContain('Gemini');
    expect(e.preflight?.({ durationSec: 600 })).toBeUndefined();
    expect(e.preflight?.({})).toBeUndefined();
    const bad = localTranscribeEngine('base', { ...deps(fakeWorker().w, tone(1)), decode: async () => { throw new EngineError('音声をデコードできませんでした。'); } });
    await expect(bad.transcribe(input())).rejects.toThrow('デコード');
    await expect(localTranscribeEngine('base', deps(fakeWorker().w, tone(1))).transcribe({ recordId: 'r', onProgress: vi.fn() })).rejects.toThrow('音声データが端末にありません');
  });
  it('モデルの事前ダウンロード（設定画面）', async () => {
    const { w, sent } = fakeWorker();
    const p = vi.fn();
    await prefetchWhisper('tiny', p, deps(w, tone(1)));
    expect(p).toHaveBeenCalledWith(0.5);
    expect(sent.map((m) => m.type)).toEqual(['init']);
    expect(w.terminated).toBe(true);
    const f = fakeWorker({ fail: 'init' });
    await expect(prefetchWhisper('tiny', p, deps(f.w, tone(1)))).rejects.toThrow('ダウンロードに失敗');
  });
});
