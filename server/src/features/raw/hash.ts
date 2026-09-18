// 抽样 hash：读文件头/中/尾各 64KB + size 喂 SHA-256（查重够用，整盘分钟级）。
// .ts 歧义靠同一头部缓冲做 MPEG-TS 魔数嗅探（TypeScript 代码文件不可能满足 188 字节 sync 网格）。
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';

/** 单段抽样长度（字节）。 */
const CHUNK = 64 * 1024;

/** MPEG-TS 判定：首字节与偏移 188 处均为 sync byte 0x47（TS 包固定 188 字节）。 */
export function isMpegTsHead(head: Buffer): boolean {
  return head.length >= 189 && head[0] === 0x47 && head[188] === 0x47;
}

/** 从 position 读最多 CHUNK 字节（钳位到 [0, size)，越界返回空缓冲）。 */
async function readChunkAt(fh: fs.FileHandle, position: number, size: number): Promise<Buffer> {
  const start = Math.max(0, Math.min(position, Math.max(0, size - 1)));
  const len = Math.min(CHUNK, size - start);
  if (len <= 0) return Buffer.alloc(0);
  const b = Buffer.alloc(len);
  const { bytesRead } = await fh.read(b, 0, len, start);
  return b.subarray(0, bytesRead);
}

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

export interface RawSample {
  /** 头部缓冲（.ts 嗅探复用，零额外 IO）。 */
  head: Buffer;
  /** 抽样 SHA-256 hex。 */
  hash: string;
}

/**
 * 读取三段抽样并计算 hash：digest = sha256("rou-raw-sample-v1" : size : len⊕head : len⊕mid : len⊕tail)。
 * 长度前缀消除拼接歧义。读失败返回 null（调用方静默跳过该文件）。
 */
export async function sampleFile(file: string, size: number): Promise<RawSample | null> {
  try {
    const fh = await fs.open(file, 'r');
    try {
      const head = await readChunkAt(fh, 0, size);
      const mid = await readChunkAt(fh, Math.floor(size / 2 - CHUNK / 2), size);
      const tail = await readChunkAt(fh, size - CHUNK, size);
      const h = createHash('sha256');
      h.update('rou-raw-sample-v1');
      h.update(`:${size}:`);
      for (const b of [head, mid, tail]) {
        h.update(u32be(b.length));
        h.update(b);
      }
      return { head, hash: h.digest('hex') };
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}
