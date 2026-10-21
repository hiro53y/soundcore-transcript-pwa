// 依存なしでPNGアイコンを生成する（zlibのみ）。出力は web/public/icons にコミットする。
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = new URL('../web/public/icons/', import.meta.url);
mkdirSync(OUT, { recursive: true });

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x / size, y / size);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const BLUE = [29, 78, 216, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];
// 波形バー（高さ比）。中央寄せ
const BARS = [0.22, 0.4, 0.62, 0.4, 0.8, 0.5, 0.3];

function icon({ maskable }) {
  const scale = maskable ? 0.62 : 0.8; // maskable は安全領域(中央80%)に収める
  return (u, v) => {
    if (!maskable) {
      // 角丸正方形
      const r = 0.2;
      const dx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
      const dy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
      if (dx * dx + dy * dy > r * r) return CLEAR;
    }
    const gx = (u - 0.5) / scale + 0.5;
    const gy = (v - 0.5) / scale + 0.5;
    const n = BARS.length;
    const slot = 0.8 / n;
    const i = Math.floor((gx - 0.1) / slot);
    if (i >= 0 && i < n) {
      const cx = 0.1 + slot * (i + 0.5);
      const half = BARS[i] / 2;
      if (Math.abs(gx - cx) < slot * 0.3 && Math.abs(gy - 0.5) < half * 0.9) return WHITE;
    }
    return BLUE;
  };
}

writeFileSync(new URL('icon-192.png', OUT), png(192, icon({ maskable: false })));
writeFileSync(new URL('icon-512.png', OUT), png(512, icon({ maskable: false })));
writeFileSync(new URL('maskable-512.png', OUT), png(512, icon({ maskable: true })));
writeFileSync(
  new URL('icon.svg', OUT),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#1d4ed8"/><g fill="#fff">${BARS.map((h, i) => `<rect x="${14 + i * 10.3}" y="${50 - h * 36}" width="6" height="${h * 72}" rx="3"/>`).join('')}</g></svg>\n`,
);
console.log('icons generated');
