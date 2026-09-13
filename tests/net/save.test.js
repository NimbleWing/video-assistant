// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  vi.useRealTimers();
});

/** 编程应答：begin/chunk/end 全部 ok，end 后异步派发 dl-settled @param {{ ok: boolean, error?: string }} [settle] */
function ackAllAndSettle(settle = { ok: true }) {
  mock.sendMessage.mockImplementation(async (msg) => {
    if (msg.type === 'rv-save-end') {
      setTimeout(() => mock.emitMessage({ type: 'dl-settled', saveId: msg.saveId, ...settle }), 0);
    }
    return { ok: true };
  });
}

describe('saveViaExtension 完整管线', () => {
  it('begin → chunk → end → dl-settled 全链路成功', async () => {
    ackAllAndSettle();
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const r = await mod.saveViaExtension([data], 'a/b.mp4', 'video/mp4');
    expect(r).toMatchObject({ ok: true, filename: 'a/b.mp4', cancelled: false, error: '' });
    const types = mock.sendMessage.mock.calls.map((c) => c[0].type);
    expect(types).toEqual(['rv-save-begin', 'rv-save-chunk', 'rv-save-end']);
    // 子目录文件名原样透传
    expect(mock.sendMessage.mock.calls[0][0].filename).toBe('a/b.mp4');
  });

  it('>16MB 分块拆成多条 chunk 消息', async () => {
    ackAllAndSettle();
    const big = new Uint8Array(16 * 1024 * 1024 + 1);
    const r = await mod.saveViaExtension([big], 'big.mp4', 'video/mp4');
    expect(r.ok).toBe(true);
    const chunks = mock.sendMessage.mock.calls.filter((c) => c[0].type === 'rv-save-chunk');
    expect(chunks.length).toBe(2);
  });

  it('onProgress 随分块推进到 100', async () => {
    ackAllAndSettle();
    /** @type {number[]} */
    const pcts = [];
    await mod.saveViaExtension([new Uint8Array(10), new Uint8Array(10)], 'x.mp4', 'video/mp4', {
      onProgress: (p) => pcts.push(p.pct),
    });
    expect(pcts.length).toBe(2);
    expect(pcts[pcts.length - 1]).toBe(100);
  });

  it('conflictAction 透传', async () => {
    ackAllAndSettle();
    await mod.saveViaExtension([new Uint8Array(1)], 'x.mp4', 'video/mp4', { conflictAction: 'overwrite' });
    expect(mock.sendMessage.mock.calls[0][0].conflictAction).toBe('overwrite');
  });
});

describe('saveViaExtension 失败路径（P0 类回归）', () => {
  it('begin 无应答 → 保存通道不可用', async () => {
    mock.sendMessage.mockImplementation(async () => undefined);
    const r = await mod.saveViaExtension([new Uint8Array(1)], 'x.mp4', 'video/mp4');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('保存通道不可用');
  });

  it('begin 显式拒绝', async () => {
    mock.sendMessage.mockImplementation(async () => ({ ok: false, error: 'offscreen 死亡' }));
    const r = await mod.saveViaExtension([new Uint8Array(1)], 'x.mp4', 'video/mp4');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('offscreen 死亡');
  });

  it('chunk ACK 失败立即报错而非挂起', async () => {
    mock.sendMessage.mockImplementation(async (msg) => {
      if (msg.type === 'rv-save-chunk') return { ok: false, error: 'unknown save' };
      return { ok: true };
    });
    const r = await mod.saveViaExtension([new Uint8Array(1)], 'x.mp4', 'video/mp4');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown save');
  });

  it('dl-settled 携带失败原因', async () => {
    ackAllAndSettle({ ok: false, error: '磁盘满' });
    const r = await mod.saveViaExtension([new Uint8Array(1)], 'x.mp4', 'video/mp4');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('磁盘满');
  });

  it('其他 saveId 的 dl-settled 被忽略', async () => {
    mock.sendMessage.mockImplementation(async (msg) => {
      if (msg.type === 'rv-save-end') {
        setTimeout(() => {
          mock.emitMessage({ type: 'dl-settled', saveId: '别的', ok: false, error: '误伤' });
          mock.emitMessage({ type: 'dl-settled', saveId: msg.saveId, ok: true });
        }, 0);
      }
      return { ok: true };
    });
    const r = await mod.saveViaExtension([new Uint8Array(1)], 'x.mp4', 'video/mp4');
    expect(r.ok).toBe(true);
  });

  it('取消保存：cancelActiveSave 立即以 cancelled 结束', async () => {
    mock.sendMessage.mockImplementation(async (msg) => {
      if (msg.type === 'rv-save-begin') return { ok: true };
      if (msg.type === 'os-abort') return { ok: true };
      return new Promise(() => {}); // chunk 永不应答，模拟大文件传输中
    });
    const p = mod.saveViaExtension([new Uint8Array(8)], 'x.mp4', 'video/mp4');
    await new Promise((r) => setTimeout(r, 20)); // 等 begin 完成、进入 chunk
    mod.cancelActiveSave();
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.cancelled).toBe(true);
    expect(r.error).toBe('已取消');
  });

  it('20 分钟无 settle → 保存超时', async () => {
    vi.useFakeTimers();
    try {
      mock.sendMessage.mockImplementation(async () => ({ ok: true }));
      const p = mod.saveViaExtension([new Uint8Array(1)], 'x.mp4', 'video/mp4');
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000 + 1);
      const r = await p;
      expect(r.ok).toBe(false);
      expect(r.error).toBe('保存超时');
    } finally {
      vi.useRealTimers();
    }
  });
});
