// 抽样 hash 单测：确定性 / 中段变化敏感 / 尺寸参与 / MPEG-TS 魔数嗅探。
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isMpegTsHead, sampleFile } from './hash.ts';

let dir = '';
const f = (name: string) => path.join(dir, name);

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'rou-hash-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 构造 MPEG-TS 魔数缓冲（188 字节 sync 网格）。 */
function tsHead(): Buffer {
  const b = Buffer.alloc(256);
  for (let i = 0; i * 188 < b.length; i++) b[i * 188] = 0x47;
  return b;
}

describe('sampleFile', () => {
  it('确定性：同内容同尺寸结果一致', async () => {
    writeFileSync(f('a.bin'), Buffer.alloc(300_000, 7));
    writeFileSync(f('b.bin'), Buffer.alloc(300_000, 7));
    const a = await sampleFile(f('a.bin'), 300_000);
    const b = await sampleFile(f('b.bin'), 300_000);
    expect(a?.hash).toBe(b?.hash);
    expect(a?.head.length).toBe(65_536);
  });

  it('中段变化敏感（64KB 头尾之外的差异也要影响 hash）', async () => {
    const buf = Buffer.alloc(300_000, 1);
    writeFileSync(f('c1.bin'), buf);
    buf.writeUInt8(9, 150_000); // 中点
    writeFileSync(f('c2.bin'), buf);
    const h1 = await sampleFile(f('c1.bin'), 300_000);
    const h2 = await sampleFile(f('c2.bin'), 300_000);
    expect(h1?.hash).not.toBe(h2?.hash);
  });

  it('尺寸参与：内容前缀相同但尺寸不同 → hash 不同', async () => {
    writeFileSync(f('d1.bin'), Buffer.alloc(150_000, 3));
    writeFileSync(f('d2.bin'), Buffer.alloc(150_001, 3));
    const h1 = await sampleFile(f('d1.bin'), 150_000);
    const h2 = await sampleFile(f('d2.bin'), 150_001);
    expect(h1?.hash).not.toBe(h2?.hash);
  });

  it('小文件：head 覆盖全文件，mid/tail 钳位不越界', async () => {
    writeFileSync(f('small.bin'), Buffer.from('tiny'));
    const s = await sampleFile(f('small.bin'), 4);
    expect(s?.head.toString()).toBe('tiny');
    expect(s?.hash).toHaveLength(64);
  });

  it('读取失败返回 null', async () => {
    expect(await sampleFile(f('nope.bin'), 10)).toBeNull();
  });
});

describe('isMpegTsHead', () => {
  it('0x47@0 且 0x47@188 判视频', () => {
    expect(isMpegTsHead(tsHead())).toBe(true);
  });

  it('文本/其他内容不满足网格', () => {
    expect(isMpegTsHead(Buffer.from('export const x = 1;\n'.repeat(20)))).toBe(false);
    expect(isMpegTsHead(Buffer.alloc(300, 0))).toBe(false);
    expect(isMpegTsHead(Buffer.alloc(100, 0x47))).toBe(false); // 长度不足
  });
});
