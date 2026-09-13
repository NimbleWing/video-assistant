// @vitest-environment node
import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { looksLikePng, unwrapIfNeeded } from '../../src/net/rou-png.js';

/** 构造含 roUd chunk 的伪装 PNG。 @param {Uint8Array} payload @param {boolean} deflate */
function makeRouPng(payload, deflate) {
  const data = deflate ? zlib.deflateSync(payload) : payload;
  const flag = deflate ? 1 : 0;
  const body = new Uint8Array(4 + 1 + data.length + 4);
  const dv = new DataView(body.buffer);
  dv.setUint32(0, 1 + data.length); // chunk 长度 = flag + 数据
  body.set([0x72, 0x6f, 0x55, 0x64], 4); // 'roUd'
  body[8] = flag;
  body.set(data, 9);
  // 末尾 4 字节 CRC 内容随意（解析器按长度跳过）
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const out = new Uint8Array(sig.length + body.length);
  out.set(sig);
  out.set(body, sig.length);
  return out;
}

describe('looksLikePng', () => {
  it('识别 PNG 签名', () => {
    expect(looksLikePng(makeRouPng(new Uint8Array([1]), false))).toBe(true);
    expect(looksLikePng(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(looksLikePng(new Uint8Array(0))).toBe(false);
    expect(looksLikePng(null)).toBe(false);
  });
});

describe('unwrapIfNeeded', () => {
  const m3u8 = new TextEncoder().encode('#EXTM3U\n#EXTINF:1.0,\na.ts\n');

  it('非 PNG 原样返回', async () => {
    const plain = new Uint8Array([0x47, 1, 2, 3]);
    expect(await unwrapIfNeeded(plain)).toBe(plain);
  });

  it('未压缩 roUd 直接取出', async () => {
    const out = await unwrapIfNeeded(makeRouPng(m3u8, false));
    expect(new TextDecoder().decode(out)).toBe('#EXTM3U\n#EXTINF:1.0,\na.ts\n');
  });

  it('deflate 压缩 roUd 解压取出', async () => {
    const out = await unwrapIfNeeded(makeRouPng(m3u8, true));
    expect(new TextDecoder().decode(out)).toBe('#EXTM3U\n#EXTINF:1.0,\na.ts\n');
  });

  it('PNG 中无 roUd 抛错', async () => {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    // 一个合法的 IHDR-ish chunk（内容随意）
    const chunk = new Uint8Array(8 + 3 + 4);
    new DataView(chunk.buffer).setUint32(0, 3);
    chunk.set([0x49, 0x48, 0x44, 0x52], 4);
    const png = new Uint8Array(sig.length + chunk.length);
    png.set(sig);
    png.set(chunk, sig.length);
    await expect(unwrapIfNeeded(png)).rejects.toThrow('PNG 中没有播放数据');
  });
});
