// mp4 时长解析（零依赖，流式 box 遍历）。
// 兼容 moov 置尾（本扩展保存管线即如此）与 64bit largesize；
// mvhd 固定在 moov 子 box 前部，最多读 moov 前 16MB 足够。
import { open } from 'node:fs/promises';

/**
 * @param p 绝对路径
 * @returns 秒；无法解析返回 null
 */
export async function mp4Duration(p: string): Promise<number | null> {
  let fh = null;
  try {
    fh = await open(p, 'r');
    const { size } = await fh.stat();
    let pos = 0;
    while (pos < size - 8) {
      const head = Buffer.alloc(8);
      await fh.read(head, 0, 8, pos);
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let headerLen = 8;
      if (boxSize === 1) {
        const ext = Buffer.alloc(8);
        await fh.read(ext, 0, 8, pos + 8);
        boxSize = Number(ext.readBigUInt64BE(0));
        headerLen = 16;
      } else if (boxSize === 0) {
        boxSize = size - pos; // size=0：本 box 延伸到文件尾
      }
      if (boxSize < headerLen || pos + boxSize > size) return null; // 损坏
      if (type === 'moov') {
        const moov = Buffer.alloc(Math.min(boxSize, 16 * 1024 * 1024));
        await fh.read(moov, 0, moov.length, pos);
        return findMvhd(moov, headerLen);
      }
      pos += boxSize; // 跳过 mdat 等大 box（seek，不读内容）
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

/** moov 子 box 顶层顺序找 mvhd。@param start moov 内容起始偏移 */
function findMvhd(moov: Buffer, start: number): number | null {
  let pos = start;
  while (pos < moov.length - 8) {
    const size = moov.readUInt32BE(pos);
    const type = moov.toString('latin1', pos + 4, pos + 8);
    if (size < 8) return null;
    if (type === 'mvhd') {
      const version = moov.readUInt8(pos + 8);
      try {
        if (version === 1) {
          const timescale = moov.readUInt32BE(pos + 28);
          const dur = Number(moov.readBigUInt64BE(pos + 32));
          return timescale ? dur / timescale : null;
        }
        const timescale = moov.readUInt32BE(pos + 20);
        const dur = moov.readUInt32BE(pos + 24);
        return timescale ? dur / timescale : null;
      } catch {
        return null;
      }
    }
    pos += size;
  }
  return null;
}
