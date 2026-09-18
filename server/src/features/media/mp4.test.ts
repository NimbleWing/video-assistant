import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mp4Duration } from './mp4.ts';

let dir = '';

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'rou-mp4-'));
});

function tmpFile(name: string, content: Buffer | string): string {
  const p = path.join(dir, name);
  writeFileSync(p, content);
  return p;
}

/** 构造 mvhd(version 0) box：timescale=10, duration=65 → 6.5s。 */
function mvhdV0(): Buffer {
  const b = Buffer.alloc(100);
  b.writeUInt32BE(100, 0);
  b.write('mvhd', 4);
  b.writeUInt8(0, 8); // version
  b.writeUInt32BE(10, 20); // timescale
  b.writeUInt32BE(65, 24); // duration
  return b;
}

/** 包一层 box。 */
function box(type: string, content: Buffer): Buffer {
  const b = Buffer.alloc(8 + content.length);
  b.writeUInt32BE(b.length, 0);
  b.write(type, 4);
  content.copy(b, 8);
  return b;
}

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('mp4Duration', () => {
  it('moov 在头部', async () => {
    const p = tmpFile('head.mp4', box('moov', mvhdV0()));
    expect(await mp4Duration(p)).toBe(6.5);
  });

  it('moov 置尾（mdat 在前）', async () => {
    const mdat = box('mdat', Buffer.alloc(64));
    const p = tmpFile('tail.mp4', Buffer.concat([mdat, box('moov', mvhdV0())]));
    expect(await mp4Duration(p)).toBe(6.5);
  });

  it('largesize（64bit）moov', async () => {
    const mvhd = mvhdV0();
    const total = 16 + mvhd.length; // 16 字节头（size=1 + largesize）
    const b = Buffer.alloc(total);
    b.writeUInt32BE(1, 0);
    b.write('moov', 4);
    b.writeBigUInt64BE(BigInt(total), 8);
    mvhd.copy(b, 16);
    const p = tmpFile('large.mp4', b);
    expect(await mp4Duration(p)).toBe(6.5);
  });

  it('空文件与非 mp4 返回 null', async () => {
    expect(await mp4Duration(tmpFile('empty.mp4', Buffer.alloc(0)))).toBeNull();
    expect(await mp4Duration(tmpFile('garbage.mp4', Buffer.alloc(256, 7)))).toBeNull();
    expect(await mp4Duration(path.join(dir, '不存在.mp4'))).toBeNull();
  });
});
