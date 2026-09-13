// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decryptAes, hexToBytes, sequenceIv } from '../../src/core/crypto.js';

describe('hexToBytes', () => {
  it('解析标准十六进制', () => {
    expect(Array.from(hexToBytes('deadbeef'))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });
  it('奇数长度前补 0', () => {
    expect(Array.from(hexToBytes('abc'))).toEqual([0x0a, 0xbc]);
  });
  it('空串得空数组', () => {
    expect(hexToBytes('').length).toBe(0);
  });
});

describe('sequenceIv', () => {
  it('16 字节，序列号置于末 4 字节大端', () => {
    const iv = sequenceIv(1);
    expect(iv.length).toBe(16);
    expect(iv[15]).toBe(1);
    expect(iv.slice(0, 12).every((b) => b === 0)).toBe(true);
  });
  it('序列号 0x01020304 的字节布局', () => {
    const iv = sequenceIv(0x01020304);
    expect([iv[12], iv[13], iv[14], iv[15]]).toEqual([1, 2, 3, 4]);
  });
  it('超出 32 位按规范截断', () => {
    expect(sequenceIv(0x100000000)[15]).toBe(0);
  });
});

describe('decryptAes', () => {
  it('AES-128-CBC 加解密往返', async () => {
    const key = hexToBytes('00112233445566778899aabbccddeeff');
    const iv = sequenceIv(7);
    const plain = new Uint8Array(32).map((_, i) => i);
    const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']);
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, plain));
    const out = await decryptAes(cipher, key, iv);
    expect(Array.from(out)).toEqual(Array.from(plain));
  });
});
