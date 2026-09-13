// @vitest-environment happy-dom
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import { installChromeMock } from '../helpers/chrome-mock.js';

/** @type {ReturnType<typeof installChromeMock>} */
let mock;
/** @type {typeof import('../../src/net/save.js')} */
let mod;

beforeEach(async () => {
  vi.resetModules();
  mock = installChromeMock();
  mod = await import('../../src/net/save.js');
});

afterEach(() => {
  mock.restore();
});

const BEGIN = { filename: 'a/b.mp4', fingerprint: 'f|2|x|y', segTotal: 2 };

/** @template T @param {T | null | undefined} v @returns {T} */
function nn(v) {
  if (v == null) throw new Error('空值（夹具错误）');
  return v;
}

describe('openSaveSession 正常链路', () => {
  it('begin ok → write（chunk）→ finalize（end）全链路', async () => {
    mock.sendMessage.mockImplementation(async (msg) => {
      if (msg.type === 'rv-save-begin') return { ok: true, resumeFrom: 0 };
      if (msg.type === 'rv-save-end') return { ok: true, finalName: 'a/b.mp4', note: '' };
      return { ok: true };
    });
    const b = await mod.openSaveSession(BEGIN);
    expect(b.ok).toBe(true);
    expect(b.resumeFrom).toBe(0);
    await nn(b.session).write(new Uint8Array([1, 2, 3]));
    const fin = await nn(b.session).finalize();
    expect(fin).toMatchObject({ ok: true, finalName: 'a/b.mp4' });
    const types = mock.sendMessage.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['rv-save-begin', 'rv-save-chunk', 'rv-save-end']);
    // 元数据透传
    expect(mock.sendMessage.mock.calls[0][0]).toMatchObject(BEGIN);
  });

  it('>16MB 分段切片成多条 chunk 消息', async () => {
    mock.sendMessage.mockImplementation(async (msg) => {
      if (msg.type === 'rv-save-begin') return { ok: true };
      if (msg.type === 'rv-save-end') return { ok: true, finalName: 'big.mp4' };
      return { ok: true };
    });
    const b = await mod.openSaveSession({ ...BEGIN, filename: 'big.mp4' });
    await nn(b.session).write(new Uint8Array(16 * 1024 * 1024 + 1));
    const chunks = mock.sendMessage.mock.calls.filter((c) => c[0].type === 'rv-save-chunk');
    expect(chunks.length).toBe(2);
  });


  it('begin 携带 resumeFrom（断点续传）', async () => {
    mock.sendMessage.mockImplementation(async () => ({ ok: true, resumeFrom: 5 }));
    const b = await mod.openSaveSession(BEGIN);
    expect(b.resumeFrom).toBe(5);
  });
});

describe('openSaveSession 失败路径', () => {
  it('begin 无应答 → 保存通道不可用', async () => {
    mock.sendMessage.mockImplementation(async () => undefined);
    const b = await mod.openSaveSession(BEGIN);
    expect(b.ok).toBe(false);
    expect(b.error).toBe('保存通道不可用');
  });

  it('begin 显式拒绝并透传错误码（REAUTH）', async () => {
    mock.sendMessage.mockImplementation(async () => ({ ok: false, code: 'REAUTH', error: '授权失效' }));
    const b = await mod.openSaveSession(BEGIN);
    expect(b.ok).toBe(false);
    expect(b.code).toBe('REAUTH');
  });

  it('chunk ACK 失败 → write 抛出带码错误', async () => {
    mock.sendMessage.mockImplementation(async (msg) => {
      if (msg.type === 'rv-save-begin') return { ok: true };
      if (msg.type === 'rv-save-chunk') return { ok: false, code: 'REAUTH', error: '写入被拒' };
      return { ok: true };
    });
    const b = await mod.openSaveSession(BEGIN);
    await expect(nn(b.session).write(new Uint8Array([1]))).rejects.toMatchObject({ message: '写入被拒', code: 'REAUTH' });
  });

  it('chunk 无应答 → 保存通道中断', async () => {
    mock.sendMessage.mockImplementation(async (msg) => {
      if (msg.type === 'rv-save-begin') return { ok: true };
      return undefined;
    });
    const b = await mod.openSaveSession(BEGIN);
    await expect(nn(b.session).write(new Uint8Array([1]))).rejects.toThrow('保存通道中断');
  });

  it('finalize 失败 → ok:false 带错误', async () => {
    mock.sendMessage.mockImplementation(async (msg) => {
      if (msg.type === 'rv-save-begin') return { ok: true };
      if (msg.type === 'rv-save-end') return { ok: false, error: 'rename 失败' };
      return { ok: true };
    });
    const b = await mod.openSaveSession(BEGIN);
    const fin = await nn(b.session).finalize();
    expect(fin).toMatchObject({ ok: false, error: 'rename 失败' });
  });

  it('取消：cancelActiveSave 后 write/finalize 抛 AbortError 且发 os-abort', async () => {
    mock.sendMessage.mockImplementation(async (msg) => {
      if (msg.type === 'rv-save-begin') return { ok: true };
      return { ok: true };
    });
    const b = await mod.openSaveSession(BEGIN);
    mod.cancelActiveSave();
    await expect(nn(b.session).write(new Uint8Array([1]))).rejects.toMatchObject({ name: 'AbortError' });
    await expect(nn(b.session).finalize()).rejects.toMatchObject({ name: 'AbortError' });
    const aborts = mock.sendMessage.mock.calls.filter((c) => c[0].type === 'os-abort');
    expect(aborts.length).toBeGreaterThan(0);
  });
});

describe('saveSmallFile（封面直写）', () => {
  it('rv-save-cover 携带文件名与 base64', async () => {
    mock.sendMessage.mockImplementation(async () => ({ ok: true }));
    const r = await mod.saveSmallFile(new Uint8Array([0xff, 0xd8, 0xff]), '剧/剧.jpg');
    expect(r.ok).toBe(true);
    const call = mock.sendMessage.mock.calls[0][0];
    expect(call.type).toBe('rv-save-cover');
    expect(call.filename).toBe('剧/剧.jpg');
    expect(typeof call.b64).toBe('string');
  });

  it('失败透传', async () => {
    mock.sendMessage.mockImplementation(async () => ({ ok: false, code: 'NOHANDLE', error: '未选择下载目录' }));
    const r = await mod.saveSmallFile(new Uint8Array([1]), 'x.jpg');
    expect(r).toMatchObject({ ok: false, code: 'NOHANDLE' });
  });
});
