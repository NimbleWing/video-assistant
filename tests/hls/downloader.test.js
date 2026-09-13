// @vitest-environment node
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

vi.mock('../../src/net/http.js', () => ({
  fetchText: vi.fn(),
  fetchBuffer: vi.fn(),
}));
vi.mock('../../src/net/save.js', () => ({
  openSaveSession: vi.fn(),
}));
vi.mock('../../src/core/crypto.js', () => ({
  decryptAes: vi.fn(async (/** @type {any} */ buf) => buf),
  sequenceIv: vi.fn(() => new Uint8Array(16)),
  hexToBytes: vi.fn(() => new Uint8Array(16)),
}));

import { downloadQuality } from '../../src/hls/downloader.js';
import { fetchBuffer, fetchText } from '../../src/net/http.js';
import { openSaveSession } from '../../src/net/save.js';

// vi.mock 工厂的 vi.fn() 无签名，统一按 any 取参
const openMock = /** @type {any} */ (openSaveSession);

const MPL = [
  '#EXTM3U',
  '#EXTINF:1.0,',
  's0.ts',
  '#EXTINF:1.0,',
  's1.ts',
  '#EXTINF:1.0,',
  's2.ts',
].join('\n');

const QUALITY = /** @type {any} */ ({
  label: 'default',
  url: 'https://cdn.example.com/v/x/index.m3u8',
  prefix: 'https://cdn.example.com/v/x/',
  resolution: '', bandwidth: 0, height: 0,
});

/** 分段字节：内容 = 序号（验证按序写出） @param {number} i */
const segBytes = (i) => new Uint8Array([i + 1, i + 1, i + 1]);

/**
 * 默认会话 mock。
 * @param {{ resumeFrom?: number }} [opts]
 */
function makeSession(opts = {}) {
  const session = {
    write: vi.fn(async () => {}),
    finalize: vi.fn(async () => ({ ok: true, finalName: 'x.mp4', note: '' })),
    abort: vi.fn(async () => {}),
  };
  vi.mocked(openSaveSession).mockResolvedValue({ ok: true, resumeFrom: opts.resumeFrom || 0, session });
  return session;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchText).mockResolvedValue(MPL);
  vi.mocked(fetchBuffer).mockImplementation(async (/** @type {string} */ url) => {
    const m = url.match(/s(\d)\.ts/);
    return /** @type {any} */ (segBytes(m ? Number(m[1]) : 0));
  });
});

describe('downloadQuality 流式链路', () => {
  it('分段按序写出，进度到 100', async () => {
    const session = makeSession();
    /** @type {number[]} */
    const pcts = [];
    const r = await downloadQuality(QUALITY, 'x.mp4', (p) => pcts.push(p.pct));
    expect(r.mode).toBe('fs');
    expect(r.filename).toBe('x.mp4');
    expect(r.bytes).toBe(9);
    // 按序：write 的内容必须是 1,2,3
    const got = /** @type {any} */ (session.write.mock.calls).map((/** @type {any} */ c) => c[0][0]);
    expect(got).toEqual([1, 2, 3]);
    expect(pcts[pcts.length - 1]).toBe(100);
    // 指纹 = 播放列表+分段数+首尾分段
    const fp = openMock.mock.calls[0][0].fingerprint;
    expect(fp).toContain('index.m3u8|3|');
    expect(fp).toContain('s0.ts');
    expect(fp).toContain('s2.ts');
  });

  it('begin done → skip', async () => {
    vi.mocked(openSaveSession).mockResolvedValue({ ok: true, done: true, resumeFrom: 0 });
    const r = await downloadQuality(QUALITY, 'x.mp4', () => {});
    expect(r.mode).toBe('skip');
    expect(vi.mocked(fetchBuffer)).not.toHaveBeenCalled();
  });

  it('begin 失败带码 → 抛带码错误', async () => {
    vi.mocked(openSaveSession).mockResolvedValue({ ok: false, code: 'REAUTH', error: '授权失效', resumeFrom: 0 });
    await expect(downloadQuality(QUALITY, 'x.mp4', () => {})).rejects.toMatchObject({ message: '授权失效', code: 'REAUTH' });
  });

  it('断点续传：resumeFrom 之后只下剩余分段', async () => {
    const session = makeSession({ resumeFrom: 1 });
    const r = await downloadQuality(QUALITY, 'x.mp4', () => {});
    expect(r.note).toContain('断点续传');
    // fetchBuffer 只拉了 s1、s2
    const urls = /** @type {any} */ (vi.mocked(fetchBuffer).mock.calls).map((/** @type {any} */ c) => c[0]);
    expect(urls.some((/** @type {string} */ u) => u.includes('s0.ts'))).toBe(false);
    expect(urls.filter((/** @type {string} */ u) => u.includes('.ts')).length).toBe(2);
    expect(/** @type {any} */ (session.write.mock.calls).map((/** @type {any} */ c) => c[0][0])).toEqual([2, 3]);
  });

  it('分段重试耗尽 → 抛错且 abort 保留半成品', async () => {
    makeSession();
    vi.mocked(fetchBuffer).mockRejectedValue(new Error('HTTP 500'));
    await expect(downloadQuality(QUALITY, 'x.mp4', () => {})).rejects.toThrow('HTTP 500');
    const beginResult = await openMock.mock.results[0].value;
    expect(beginResult.session.abort).toHaveBeenCalledOnce();
  }, 15000);

  it('用户取消 → AbortError 且 abort', async () => {
    const session = makeSession();
    const ctrl = new AbortController();
    vi.mocked(fetchBuffer).mockImplementation(async () => {
      ctrl.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    await expect(downloadQuality(QUALITY, 'x.mp4', () => {}, ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(session.abort).toHaveBeenCalledOnce();
  });

  it('write ACK 失败 → 传播且 abort', async () => {
    const session = makeSession();
    session.write.mockRejectedValue(Object.assign(new Error('保存通道中断'), { code: 'X' }));
    await expect(downloadQuality(QUALITY, 'x.mp4', () => {})).rejects.toThrow('保存通道中断');
    expect(session.abort).toHaveBeenCalledOnce();
  });
});
