// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from '../helpers/chrome-mock.js';

const BATCH_KEY = 'rv-hud:batch';

/** @type {ReturnType<typeof installChromeMock>} */
let mock;
/** @type {typeof import('../../src/features/batch.js')} */
let batch;
/** @type {any} */
let toast;
/** @type {any} */
let abort;
/** @type {any} */
let downloadCurrent;

/** @param {string} path @param {any} pageProps */
function setPage(path, pageProps) {
  window.happyDOM.setURL(`https://rou.video${path}`);
  document.body.innerHTML = pageProps == null
    ? ''
    : `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps } })}</script>`;
}

const SINGLES = {
  videos: [
    { id: 'v1', name: '视频1', duration: 100 },
    { id: 'v2', name: '视频2', duration: 100 },
    { id: 'v3', name: '视频3', duration: 100 },
  ],
  totalPage: 3,
  pageNum: 1,
  totalVideoNum: 60,
};

const SERIES_LIST = {
  list: [
    { id: 's1', name: '剧集A', totalEpisodes: 12 },
    { id: 's2', name: '剧集B', totalEpisodes: 8 },
  ],
  totalPage: 1,
  pageNum: 1,
};

const EPISODES = {
  series: { nameZh: '剧集A' },
  episodes: [
    { id: 'e1', name: '第1集', episode: 1 },
    { id: 'e2', name: '第2集', episode: 2 },
  ],
};

/** 造一个进行中的批次并存入 storage */
async function seedBatch(overrides = {}) {
  const b = {
    active: true,
    mode: 'single',
    limit: 0,
    listingPages: [],
    seriesQueue: [],
    videoQueue: [],
    current: null,
    done: 0,
    failed: [],
    total: 0,
    note: '',
    lastHarvested: '',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
  await mock.store.set(BATCH_KEY, b);
  return b;
}

/** 读出当前存储的批次 */
async function stored() {
  return mock.store.get(BATCH_KEY) || null;
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers(); // navTo 的 1200ms 跳转定时器挂起，避免测试间串扰
  mock = installChromeMock();
  toast = vi.fn();
  abort = vi.fn();
  downloadCurrent = vi.fn(async () => {});
  batch = await import('../../src/features/batch.js');
  batch.initBatch({ toast, abort, downloadCurrent });
});

afterEach(() => {
  vi.useRealTimers();
  mock.restore();
});

describe('detectListing', () => {
  it('剧集列表页 → series', () => {
    setPage('/series', SERIES_LIST);
    const d = batch.detectListing();
    expect(d).toMatchObject({ kind: 'series', itemCount: 2, totalPage: 1, pageNum: 1 });
  });

  it('单片列表页 → single', () => {
    setPage('/v', SINGLES);
    const d = batch.detectListing();
    expect(d).toMatchObject({ kind: 'single', itemCount: 3, totalPage: 3, total: 60 });
  });

  it('播放页不是列表页', () => {
    setPage('/v/abc123', null);
    expect(batch.detectListing()).toBeNull();
  });

  it('DOM 兜底：按 /s/ 与 /v/ 链接多数决', () => {
    setPage('/home', null);
    document.body.innerHTML = '<a href="/s/a">A</a><a href="/s/b">B</a><a href="/v/c">C</a>';
    const d = batch.detectListing();
    expect(d).toMatchObject({ kind: 'series', itemCount: 2, fallback: true });
  });

  it('同一路径命中缓存（返回同一对象）', () => {
    setPage('/series', SERIES_LIST);
    expect(batch.detectListing()).toBe(batch.detectListing());
  });
});

describe('startBatch', () => {
  it('单片模式：收割队列并推进首项', async () => {
    setPage('/v', SINGLES);
    await batch.startBatch('single');
    const b = await stored();
    expect(b.active).toBe(true);
    expect(b.current).toMatchObject({ id: 'v1' });
    expect(b.videoQueue.map((/** @type {any} */ v) => v.id)).toEqual(['v2', 'v3']);
    expect(b.expectedPath).toBe('/v/v1');
    expect(b.total).toBe(3);
  });

  it('limit 只约束列表层项数', async () => {
    setPage('/v', SINGLES);
    await batch.startBatch('single', { limit: 2 });
    const b = await stored();
    expect(b.limit).toBe(2);
    expect(b.videoQueue.length + 1).toBe(2); // current 占一个额度
  });

  it('剧集模式：剧集入 seriesQueue，首跳汇总页', async () => {
    setPage('/series', SERIES_LIST);
    await batch.startBatch('series');
    const b = await stored();
    expect(b.seriesQueue.map((/** @type {any} */ s) => s.id)).toEqual(['s2']); // s1 已弹出
    expect(b.current).toBeNull();
    expect(b.expectedPath).toBe('/s/s1');
  });

  it('全部页：排入后续翻页', async () => {
    setPage('/v', SINGLES);
    await batch.startBatch('single', { allPages: true });
    const b = await stored();
    expect(b.listingPages).toEqual(['/v?page=2', '/v?page=3']);
  });

  it('非列表页抛错', async () => {
    setPage('/v/abc123', null);
    await expect(batch.startBatch('single')).rejects.toThrow('当前页面不是列表页');
  });

  it('空列表抛错', async () => {
    // 页面能识别（剧集列表），但单片模式收割不到条目
    setPage('/series', SERIES_LIST);
    await expect(batch.startBatch('single')).rejects.toThrow('当前页未检测到单片条目');
  });
});

describe('onDownloadSettled', () => {
  it('成功：done+1 并推进下一项', async () => {
    await seedBatch({ current: { id: 'v1', name: '视频1' }, videoQueue: [{ id: 'v2', name: '视频2' }] });
    const handled = await batch.onDownloadSettled({ ok: true });
    expect(handled).toBe(true);
    const b = await stored();
    expect(b.done).toBe(1);
    expect(b.current.id).toBe('v2');
    expect(b.expectedPath).toBe('/v/v2');
  });

  it('失败：记录原因并跳过；末项失败则批次完成', async () => {
    await seedBatch({ current: { id: 'v1', name: '视频1' }, videoQueue: [] });
    await batch.onDownloadSettled({ ok: false, error: '网络错误' });
    const b = await stored();
    expect(b.failed).toEqual([{ id: 'v1', name: '视频1', error: '网络错误' }]);
    expect(b.active).toBe(false);
    expect(b.note).toBe('done');
    expect(b.finishedAt).toBeGreaterThan(0);
    expect(toast).toHaveBeenCalledOnce();
  });

  it('无进行中批次返回 false', async () => {
    expect(await batch.onDownloadSettled({ ok: true })).toBe(false);
    await seedBatch({ active: false, current: null });
    expect(await batch.onDownloadSettled({ ok: true })).toBe(false);
  });
});

describe('stopBatch', () => {
  it('当前项放回队首、批次转停、触发 abort', async () => {
    await seedBatch({ current: { id: 'v1', name: '视频1' }, videoQueue: [{ id: 'v2', name: '视频2' }] });
    await batch.stopBatch();
    const b = await stored();
    expect(b.active).toBe(false);
    expect(b.current).toBeNull();
    expect(b.videoQueue.map((/** @type {any} */ v) => v.id)).toEqual(['v1', 'v2']);
    expect(b.stoppedAt).toBeGreaterThan(0);
    expect(abort).toHaveBeenCalledOnce();
  });
});

describe('retryFailed / resumeBatch', () => {
  it('retryFailed：无批次抛错', async () => {
    await expect(batch.retryFailed()).rejects.toThrow('没有历史批次记录');
  });

  it('retryFailed：用失败项重建队列', async () => {
    await seedBatch({ active: false, failed: [{ id: 'v9', name: '视频9', error: 'x' }] });
    await batch.retryFailed();
    const b = await stored();
    expect(b.active).toBe(true);
    expect(b.done).toBe(0);
    expect(b.failed).toEqual([]);
    expect(b.current.id).toBe('v9'); // 已推进
  });

  it('retryFailed：批次进行中抛错', async () => {
    await seedBatch({ active: true });
    await expect(batch.retryFailed()).rejects.toThrow('批次进行中');
  });

  it('resumeBatch：停止后继续剩余', async () => {
    await seedBatch({ active: false, videoQueue: [{ id: 'v2', name: '视频2' }], stoppedAt: Date.now() });
    await batch.resumeBatch();
    const b = await stored();
    expect(b.active).toBe(true);
    expect(b.current.id).toBe('v2');
  });

  it('resumeBatch：无剩余项抛错', async () => {
    await seedBatch({ active: false, videoQueue: [], seriesQueue: [], listingPages: [] });
    await expect(batch.resumeBatch()).rejects.toThrow('没有剩余项可继续');
  });
});

describe('maybeContinueBatch（认领制）', () => {
  it('非流水线页面：原地暂停，不收割不跳页', async () => {
    await seedBatch({
      expectedPath: '/v/v2',
      videoQueue: [{ id: 'v2', name: '视频2' }, { id: 'v3', name: '视频3' }],
    });
    setPage('/v/OTHER', null); // 用户手动打开的页面
    await batch.maybeContinueBatch();
    const b = await stored();
    expect(b.videoQueue.length).toBe(2); // 队列未被污染
    expect(downloadCurrent).not.toHaveBeenCalled();
  });

  it('播放页匹配 current：触发下载', async () => {
    await seedBatch({ expectedPath: '/v/v1', current: { id: 'v1', name: '视频1' } });
    setPage('/v/v1', null);
    await batch.maybeContinueBatch();
    expect(downloadCurrent).toHaveBeenCalledOnce();
    const b = await stored();
    expect(b.note).toBe('下载中：视频1');
  });

  it('汇总页收割集数并推进首集', async () => {
    await seedBatch({ mode: 'series', expectedPath: '/s/s1', seriesQueue: [] });
    setPage('/s/s1', EPISODES);
    await batch.maybeContinueBatch();
    const b = await stored();
    expect(b.seriesTaken).toBe(1);
    expect(b.current.id).toBe('e1');
    expect(b.videoQueue.map((/** @type {any} */ v) => v.id)).toEqual(['e2']);
    expect(b.total).toBe(2);
    expect(b.note).toBe('下载中：第1集'); // advance 覆盖了收割注记
  });

  it('汇总页刷新不重复收割', async () => {
    await seedBatch({
      mode: 'series',
      expectedPath: '/s/s1',
      lastHarvested: '/s/s1',
      videoQueue: [{ id: 'e1', name: '第1集' }],
      seriesTaken: 1,
    });
    setPage('/s/s1', EPISODES);
    await batch.maybeContinueBatch();
    const b = await stored();
    expect(b.seriesTaken).toBe(1); // 未重复收割
    expect(b.videoQueue.length).toBe(0); // e1 被推进为 current
    expect(b.current.id).toBe('e1');
  });

  it('列表根页续跑：继续收割本页', async () => {
    await seedBatch({
      expectedPath: '/v?page=2',
      listingPages: [],
      videoQueue: [],
      lastHarvested: '/v',
    });
    setPage('/v?page=2', SINGLES);
    await batch.maybeContinueBatch();
    const b = await stored();
    expect(b.total).toBe(3);
    expect(b.current.id).toBe('v1');
    expect(b.videoQueue.map((/** @type {any} */ v) => v.id)).toEqual(['v2', 'v3']);
  });

  it('达到 limit：清空翻页队列直接收尾', async () => {
    await seedBatch({
      limit: 1,
      mode: 'single',
      expectedPath: '/v?page=2',
      done: 1,
      listingPages: ['/v?page=3'],
      videoQueue: [],
      lastHarvested: '/v',
    });
    setPage('/v?page=2', SINGLES);
    await batch.maybeContinueBatch();
    const b = await stored();
    expect(b.listingPages).toEqual([]);
    expect(b.active).toBe(false); // 队列清空 → advance 走 done
    expect(b.note).toBe('done');
  });

  it('无法识别的页面：批次中断并提示', async () => {
    await seedBatch({ expectedPath: '/home' });
    setPage('/home', null); // 无 NEXT_DATA 也无链接
    await batch.maybeContinueBatch();
    const b = await stored();
    expect(b.active).toBe(false);
    expect(b.note).toBe('error: 无法识别的页面');
    expect(toast).toHaveBeenCalledWith('连续下载中断：页面无法识别');
  });
});

describe('后台标签页驱动（advance worker 模式）', () => {
  it('startBatch 请求 SW 开后台标签页，当前页不跳转', async () => {
    setPage('/v', SINGLES);
    await batch.startBatch('single');
    const calls = mock.sendMessage.mock.calls.map((c) => c[0]);
    const open = calls.find((m) => m.type === 'rv-batch-open');
    expect(open).toMatchObject({ url: '/v/v1' });
    expect(location.pathname).toBe('/v'); // 未被劫持
  });

  it('resumeBatch 也走后台标签页', async () => {
    await seedBatch({ active: false, videoQueue: [{ id: 'v2', name: '视频2' }], stoppedAt: Date.now() });
    await batch.resumeBatch();
    const open = mock.sendMessage.mock.calls.map((c) => c[0]).find((m) => m.type === 'rv-batch-open');
    expect(open).toMatchObject({ url: '/v/v2' });
  });

  it('onDownloadSettled 在工作标签页内自驱（不发 rv-batch-open）', async () => {
    await seedBatch({ current: { id: 'v1', name: '视频1' }, videoQueue: [{ id: 'v2', name: '视频2' }] });
    await batch.onDownloadSettled({ ok: true });
    const open = mock.sendMessage.mock.calls.map((c) => c[0]).find((m) => m.type === 'rv-batch-open');
    expect(open).toBeUndefined();
  });

  it('spawnWorker：进行中批次重开标签页；无批次抛错', async () => {
    await expect(batch.spawnWorker()).rejects.toThrow('没有进行中的批次');
    await seedBatch({ expectedPath: '/v/v2', videoQueue: [{ id: 'v2', name: '视频2' }] });
    await batch.spawnWorker();
    const open = mock.sendMessage.mock.calls.map((c) => c[0]).find((m) => m.type === 'rv-batch-open');
    expect(open).toMatchObject({ url: '/v/v2' });
  });
});

describe('onDownloadSettled 授权暂停', () => {
  it('REAUTH：当前项回队首，批次暂停', async () => {
    await seedBatch({ current: { id: 'v1', name: '视频1' }, videoQueue: [{ id: 'v2', name: '视频2' }] });
    const handled = await batch.onDownloadSettled({ ok: false, error: '授权失效', code: 'REAUTH' });
    expect(handled).toBe(true);
    const b = await stored();
    expect(b.active).toBe(false);
    expect(b.current).toBeNull();
    expect(b.videoQueue.map((/** @type {any} */ v) => v.id)).toEqual(['v1', 'v2']);
    expect(b.failed).toEqual([]); // 不算失败
    expect(b.stoppedAt).toBeGreaterThan(0);
    expect(b.note).toContain('重新授权');
    expect(b.stoppedReason).toBe('REAUTH');
    expect(toast).toHaveBeenCalledOnce();
  });

  it('NOHANDLE：同样暂停且提示选目录', async () => {
    await seedBatch({ current: { id: 'v1', name: '视频1' }, videoQueue: [] });
    await batch.onDownloadSettled({ ok: false, error: '未选择下载目录', code: 'NOHANDLE' });
    const b = await stored();
    expect(b.active).toBe(false);
    expect(b.note).toContain('选择');
    expect(b.stoppedReason).toBe('NOHANDLE');
  });
});
describe('worker 驱动失败降级', () => {
  it('rv-batch-open 失败 → toast 提示并降级为当前页跳转', async () => {
    mock.sendMessage.mockImplementation(async (msg) => {
      if (msg.type === 'rv-batch-open') return { ok: false, error: 'SW 未响应' };
      return { ok: true };
    });
    setPage('/v', SINGLES);
    await batch.startBatch('single');
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('当前页驱动'), 4000);
    const b = await stored();
    expect(b.active).toBe(true); // 批次照常推进
    // NAV_DELAY 后当前页被导航（老行为兜底）
    await vi.advanceTimersByTimeAsync(1300);
    expect(location.pathname).toBe('/v/v1');
  });

  it('sendMessage 直接拒绝同样降级', async () => {
    mock.sendMessage.mockImplementation(async (msg) => {
      if (msg.type === 'rv-batch-open') throw new Error('Could not establish connection');
      return { ok: true };
    });
    setPage('/v', SINGLES);
    await batch.startBatch('single');
    await vi.advanceTimersByTimeAsync(1300);
    expect(location.pathname).toBe('/v/v1');
  });
});

describe('continuing 闸门复位', () => {
  it('认领失败（非流水线页面）后可再次认领', async () => {
    await seedBatch({ expectedPath: '/v/v2', videoQueue: [{ id: 'v2', name: '视频2' }] });
    setPage('/v/OTHER', null);
    await batch.maybeContinueBatch(); // 暂停返回
    // 导航到认领页后（模拟同页 SPA 重载内容脚本再触发）
    setPage('/v/v2', null);
    await seedBatch({ expectedPath: '/v/v2', current: { id: 'v2', name: '视频2' } });
    await batch.maybeContinueBatch();
    expect(downloadCurrent).toHaveBeenCalledOnce();
  });
});