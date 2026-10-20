import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { dedupeBoundary, mergeChunks } from '../src/audio/merge.js';
import { parseSilences, planChunks } from '../src/audio/split.js';
import { sniffAudio, validateAudioFile } from '../src/audio/validate.js';
import { makeMp3 } from './helpers.js';

describe('sniffAudio', () => {
  it('ID3 / MPEG frame / WAV / m4a を判定する', () => {
    expect(sniffAudio(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00'))).toBe('mp3');
    expect(sniffAudio(Uint8Array.from([0xff, 0xfb, 0x90, 0x00]))).toBe('mp3');
    expect(sniffAudio(Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt '))).toBe('wav');
    expect(sniffAudio(Buffer.from('\x00\x00\x00\x20ftypM4A '))).toBe('mp4');
  });
  it('テキストや画像は拒否する', () => {
    expect(sniffAudio(Buffer.from('hello world, not audio'))).toBeNull();
    expect(sniffAudio(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBeNull();
  });
});

describe('validateAudioFile', () => {
  const lim = { maxBytes: 10 * 1024 * 1024, maxDurationSec: 60 };
  it('正常なMP3の長さを返す', async () => {
    const f = makeMp3({ seconds: 3 });
    const r = await validateAudioFile(f, { size: readFileSync(f).length, ...lim });
    expect(r.kind).toBe('mp3');
    expect(r.durationSec).toBeGreaterThan(2.5);
  });
  it('0byte', async () => {
    const f = path.join(os.tmpdir(), 'empty-test.mp3');
    writeFileSync(f, '');
    await expect(validateAudioFile(f, { size: 0, ...lim })).rejects.toMatchObject({ code: 'file_empty' });
  });
  it('MP3拡張子でも中身がテキストなら拒否', async () => {
    const f = path.join(os.tmpdir(), 'fake-test.mp3');
    writeFileSync(f, 'this is not an mp3 file at all');
    await expect(validateAudioFile(f, { size: 30, ...lim })).rejects.toMatchObject({ code: 'file_not_audio' });
  });
  it('ヘッダだけMP3で壊れている場合は corrupt', async () => {
    const f = path.join(os.tmpdir(), 'corrupt-test.mp3');
    writeFileSync(f, Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00'), Buffer.alloc(200, 7)]));
    await expect(validateAudioFile(f, { size: 210, ...lim })).rejects.toMatchObject({ code: 'file_corrupt' });
  });
  it('サイズ超過・長さ超過', async () => {
    const f = makeMp3({ seconds: 5 });
    await expect(validateAudioFile(f, { size: 999, maxBytes: 100, maxDurationSec: 60 })).rejects.toMatchObject({ code: 'file_too_large' });
    await expect(validateAudioFile(f, { size: 1000, maxBytes: 10_000_000, maxDurationSec: 2 })).rejects.toMatchObject({ code: 'duration_too_long' });
  });
});

describe('planChunks', () => {
  it('短い音声は1チャンク', () => {
    expect(planChunks(100, [], { targetSec: 600, overlapSec: 3 })).toHaveLength(1);
  });
  it('無音点で分割し、連続・順序・全域カバー', () => {
    const sil = [{ start: 590, end: 592 }, { start: 1195, end: 1197 }];
    const p = planChunks(1500, sil, { targetSec: 600, overlapSec: 3 });
    expect(p.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(p[0]!.endSec).toBeCloseTo(591);
    expect(p[1]!.startSec).toBeCloseTo(591);
    expect(p.every((c) => !c.overlapsPrevious)).toBe(true);
    expect(p.at(-1)!.endSec).toBe(1500);
  });
  it('無音が無ければ強制分割しオーバーラップを付ける', () => {
    const p = planChunks(1500, [], { targetSec: 600, overlapSec: 3 });
    expect(p[1]!.overlapsPrevious).toBe(true);
    expect(p[1]!.startSec).toBe(597);
    expect(p[0]!.endSec).toBe(600);
  });
});

describe('parseSilences', () => {
  it('silencedetect出力を解析', () => {
    const s = parseSilences('[silencedetect @ x] silence_start: 1.5\n[silencedetect @ x] silence_end: 2.7 | silence_duration: 1.2', 10);
    expect(s).toEqual([{ start: 1.5, end: 2.7 }]);
  });
});

describe('merge', () => {
  it('境界の重複文を除去する', () => {
    const prev = 'これまでの経緯を説明します。次に炉圧の変動について確認しました。';
    const next = '炉圧の変動について確認しました。 その後板温を調整しました。';
    expect(dedupeBoundary(prev, next)).toBe('その後板温を調整しました。');
  });
  it('一致しなければ変更しない', () => {
    expect(dedupeBoundary('あいうえおかきくけこ', 'さしすせそたちつてと')).toBe('さしすせそたちつてと');
  });
  it('順序通りに結合しタイムスタンプ見出しを付ける', () => {
    const t = mergeChunks([
      { startSec: 600, text: '後半', overlapsPrevious: false },
      { startSec: 0, text: '前半', overlapsPrevious: false },
    ]);
    expect(t).toBe('[00:00:00]\n前半\n\n[00:10:00]\n後半');
  });
  it('単一チャンクは見出し無し', () => {
    expect(mergeChunks([{ startSec: 0, text: ' 本文 ', overlapsPrevious: false }])).toBe('本文');
  });
});
