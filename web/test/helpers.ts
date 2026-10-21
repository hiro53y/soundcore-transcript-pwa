/** 実音声は使わず、先頭バイトだけMP3風のモックデータを作る。 */
export function fakeMp3(size = 4096, seed = 1): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(new ArrayBuffer(size));
  b.set([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0]); // 'ID3'
  for (let i = 10; i < size; i++) b[i] = (i * 31 + seed * 17) & 0xff;
  return b;
}
export const mp3File = (name = 'meeting.mp3', type = 'audio/mpeg', size = 4096, seed = 1) => new File([fakeMp3(size, seed)], name, { type });
