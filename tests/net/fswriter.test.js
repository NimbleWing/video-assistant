// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  FsStreamWriter, fsFileExists, fsReadJson, fsRemove, fsWriteJson, resolveDir,
} from '../../src/net/fswriter.js';
import { makeFsMock } from '../helpers/fs-mock.js';

/** @template T @param {T | null | undefined} v @returns {T} */
function nn(v) {
  if (v == null) throw new Error('空值（夹具错误）');
  return v;
}

describe('resolveDir / fsFileExists', () => {
  it('逐级建目录并判定存在性', async () => {
    const { root } = makeFsMock();
    expect(await fsFileExists(root, 'a/b/c.mp4')).toBe(false);
    const e = nn(await resolveDir(root, 'a/b/c.mp4', true));
    expect(e.base).toBe('c.mp4');
    await e.dir.getFileHandle('c.mp4', { create: true });
    expect(await fsFileExists(root, 'a/b/c.mp4')).toBe(true);
    expect(await fsFileExists(root, 'a/b/x.mp4')).toBe(false);
    expect(await fsFileExists(root, 'a/x/c.mp4')).toBe(false);
  });
});

describe('JSON 读写与删除', () => {
  it('roundtrip / 缺失返回 null / 删除幂等', async () => {
    const { root } = makeFsMock();
    expect(await fsReadJson(root, 's/x.json')).toBeNull();
    await fsWriteJson(root, 's/x.json', { a: 1, b: '中文' });
    expect(await fsReadJson(root, 's/x.json')).toEqual({ a: 1, b: '中文' });
    await fsRemove(root, 's/x.json');
    expect(await fsReadJson(root, 's/x.json')).toBeNull();
    await fsRemove(root, 's/x.json'); // 不存在不抛
  });
});

describe('FsStreamWriter', () => {
  it('create 顺序写并推进 position', async () => {
    const { root } = makeFsMock();
    const w = await FsStreamWriter.create(root, 'f.bin');
    await w.write(new Uint8Array([1, 2, 3]));
    await w.write(new Uint8Array([4, 5]));
    expect(w.position).toBe(5);
    await w.close();
    expect((await fsReadBytes(root, 'f.bin'))).toEqual([1, 2, 3, 4, 5]);
  });

  it('seek 回改（largesize 补丁语义）', async () => {
    const { root } = makeFsMock();
    const w = await FsStreamWriter.create(root, 'f.bin');
    await w.write(new Uint8Array([0, 0, 0, 0, 9, 9, 9]));
    await w.seek(0);
    await w.write(new Uint8Array([0, 0, 0, 7]));
    await w.close();
    expect(await fsReadBytes(root, 'f.bin')).toEqual([0, 0, 0, 7, 9, 9, 9]);
  });

  it('resume 校验大小：一致追加 / 不一致返回 null / 缺失返回 null', async () => {
    const { root } = makeFsMock();
    const w = await FsStreamWriter.create(root, 'f.bin');
    await w.write(new Uint8Array([1, 2, 3]));
    await w.close();
    expect(await FsStreamWriter.resume(root, 'f.bin', 5)).toBeNull();
    expect(await FsStreamWriter.resume(root, 'missing.bin', 3)).toBeNull();
    const r = nn(await FsStreamWriter.resume(root, 'f.bin', 3));
    await r.write(new Uint8Array([4]));
    await r.close();
    expect(await fsReadBytes(root, 'f.bin')).toEqual([1, 2, 3, 4]);
  });

  it('moveTo 改名保留内容', async () => {
    const { root } = makeFsMock();
    const w = await FsStreamWriter.create(root, 'x.part');
    await w.write(new Uint8Array([7, 7, 7]));
    await w.moveTo('x.mp4');
    expect(await fsFileExists(root, 'x.part')).toBe(false);
    expect(await fsReadBytes(root, 'x.mp4')).toEqual([7, 7, 7]);
  });

  it('moveTo 无 move() 时复制+删除兜底', async () => {
    const { root } = makeFsMock();
    const w = await FsStreamWriter.create(root, 'x.part');
    await w.write(new Uint8Array([8]));
    // 模拟老内核：删掉 move 方法
    const handle = /** @type {any} */ (w.handle);
    handle.move = undefined;
    await w.moveTo('x.mp4');
    expect(await fsFileExists(root, 'x.part')).toBe(false);
    expect(await fsReadBytes(root, 'x.mp4')).toEqual([8]);
  });

  it('discard 删除半成品', async () => {
    const { root } = makeFsMock();
    const w = await FsStreamWriter.create(root, 'x.part');
    await w.write(new Uint8Array([1]));
    await w.discard();
    expect(await fsFileExists(root, 'x.part')).toBe(false);
  });
});

/** @param {any} root @param {string} name @returns {Promise<number[]>} */
async function fsReadBytes(root, name) {
  const e = nn(await resolveDir(root, name, false));
  const fh = await e.dir.getFileHandle(e.base, { create: false });
  const f = await fh.getFile();
  return Array.from(new Uint8Array(await f.arrayBuffer()));
}
