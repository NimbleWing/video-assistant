import { BATCH_KEY } from '../core/constants.js';
import { Logger } from '../core/logger.js';
import { errText } from '../core/utils.js';
import { getPageProps, videoIdFromPath } from '../site/video-info.js';
import { queryLedger } from '../net/ledger.js';

// 连续下载编排器。
// 状态保存在 chrome.storage.local（chrome.storage.session 在内容脚本中不可用：
// "Access to storage is not allowed from this context"）。为获得"浏览器关闭即失效"
// 的语义，service worker 在 runtime.onStartup 时清除残留任务。
//
// 每个匹配页面的内容脚本都是流水线工人：
//   列表根页 → 收割条目 → 跳播放页 /s/ 汇总页 → 收割集数 → 跳 /v/ → 下载 → 下一项…
// 侧边栏通过 storage.onChanged 订阅状态，通过 rv-cmd 下发开始/停止命令。

/**
 * @typedef {Object} BatchItem
 * @property {string} id
 * @property {string} name
 */

/**
 * @typedef {Object} BatchFailedItem
 * @property {string} id
 * @property {string} name
 * @property {string} error
 */

/**
 * @typedef {Object} ListingInfo
 * @property {'series' | 'single'} kind
 * @property {number} itemCount
 * @property {number} totalPage
 * @property {number} pageNum
 * @property {number} total
 * @property {boolean} [fallback] 是否为 DOM 兜底检测（无 Next.js 数据时的粗略结果）
 */

/**
 * @typedef {Object} BatchState
 * @property {boolean} active
 * @property {'series' | 'single'} mode
 * @property {number} limit 列表层项数上限（0 = 不限）
 * @property {string[]} listingPages 待收割列表页（pathname+search）
 * @property {BatchItem[]} seriesQueue
 * @property {BatchItem[]} videoQueue
 * @property {BatchItem | null} current
 * @property {number} done 已完成总数（含跳过）
 * @property {number} [skipped] 其中因本地已存在而跳过的项数
 * @property {BatchFailedItem[]} failed
 * @property {number} total
 * @property {string} note
 * @property {string | null} [expectedPath] 认领标记：只推进自己导航出的页面
 * @property {string} [lastHarvested] 防刷新重复收割（pathname+search）
 * @property {number} [seriesTaken] 已收割的剧集数（配合 limit 计算剩余额度）
 * @property {number} startedAt
 * @property {number} updatedAt
 * @property {number} [finishedAt]
 * @property {number | null} [stoppedAt]
 */

/**
 * @typedef {Object} BatchHooks
 * @property {(msg: string, ms?: number) => void} [toast]
 * @property {() => void} [abort]
 * @property {() => Promise<void>} [downloadCurrent]
 */

const NAV_DELAY = 1200; // 跳转前稍作停顿，让状态落盘、页面稳定

/** @type {BatchHooks} */
let hooks = {};
let continuing = false;
/** @type {ReturnType<typeof setTimeout> | 0} */
let navTimer = 0;

/** @param {BatchHooks} h */
export function initBatch(h) {
  hooks = h || {};
}

function batchArea() {
  return chrome.storage?.local || null;
}

/** @returns {Promise<BatchState | null>} */
export async function getBatch() {
  try {
    const area = batchArea();
    if (!area) {
      Logger.warn('BATCH', '无可用存储区');
      return null;
    }
    const raw = /** @type {Record<string, any>} */ (await area.get(BATCH_KEY));
    return raw[BATCH_KEY] || null;
  } catch (e) {
    Logger.warn('BATCH', `读取状态失败: ${errText(e)}`);
    return null;
  }
}

/** @param {BatchState} b */
async function saveBatch(b) {
  b.updatedAt = Date.now();
  try {
    const area = batchArea();
    if (!area) throw new Error('无可用存储区');
    await area.set({ [BATCH_KEY]: b });
  } catch (e) {
    Logger.warn('BATCH', `状态保存失败: ${errText(e)}`);
  }
}

/** @returns {Promise<void>} */
export async function clearBatch() {
  try { await batchArea()?.remove(BATCH_KEY); } catch {}
}

// ---------------------------------------------------------------- 页面检测

/** @type {{ path: string | null, result: ListingInfo | null | undefined }} */
let detectCache = { path: null, result: undefined };

// 判断当前页是不是列表根页，以及是剧集列表还是单片列表。
/** @returns {ListingInfo | null} */
export function detectListing() {
  const path = location.pathname + location.search;
  if (detectCache.path === path) return detectCache.result ?? null;
  /** @type {ListingInfo | null} */
  let result = null;
  if (!path.startsWith('/v/') && !path.startsWith('/s/')) {
    const pp = getPageProps();
    const list = Array.isArray(pp.list) ? pp.list : null;
    const videos = Array.isArray(pp.videos) ? pp.videos : null;
    if (list?.length && list[0] && ('totalEpisodes' in list[0] || 'episodeCount' in list[0])) {
      result = {
        kind: 'series',
        itemCount: list.length,
        totalPage: Number(pp.totalPage) || 1,
        pageNum: Number(pp.pageNum) || 1,
        total: Number(pp.total) || list.length,
      };
    } else {
      const vids = videos?.length ? videos : (list?.length && list[0] && 'duration' in list[0] ? list : null);
      if (vids) {
        result = {
          kind: 'single',
          itemCount: vids.length,
          totalPage: Number(pp.totalPage) || 1,
          pageNum: Number(pp.pageNum) || 1,
          total: Number(pp.totalVideoNum ?? pp.total) || vids.length,
        };
      } else {
        // DOM 兜底（站点已移除 __NEXT_DATA__，列表页纯 SSR HTML）
        const sItems = domLinkItems('/s/');
        const vItems = domLinkItems('/v/');
        if (sItems.length || vItems.length) {
          const pager = domPagerInfo();
          const count = Math.max(sItems.length, vItems.length);
          result = {
            kind: sItems.length >= vItems.length ? 'series' : 'single',
            itemCount: count,
            totalPage: pager.totalPage,
            pageNum: pager.pageNum,
            total: count,
            fallback: true,
          };
        }
      }
    }
  }
  detectCache = { path, result };
  return result;
}

/**
 * DOM 兜底收割：从卡片链接提取站内 id + 标题（卡片标题在 h2/h3）。
 * @param {string} prefix '/v/' 或 '/s/'
 * @returns {BatchItem[]}
 */
function domLinkItems(prefix) {
  /** @type {Map<string, BatchItem>} */
  const out = new Map();
  const re = new RegExp(`^${prefix.replace(/\//g, '\\/')}([^/?#]+)`);
  for (const a of document.querySelectorAll(`a[href^="${prefix}"]`)) {
    const m = (a.getAttribute('href') || '').match(re);
    if (!m) continue;
    const id = decodeURIComponent(m[1]);
    if (out.has(id)) continue;
    const name = (a.querySelector('h2, h3')?.textContent || '').trim() || id;
    out.set(id, { id, name });
  }
  return Array.from(out.values());
}

/** DOM 兜底：从同列表翻页链接（?page=N）提取页码信息 */
function domPagerInfo() {
  let maxPage = 1;
  for (const el of document.querySelectorAll('a[href]')) {
    const a = /** @type {HTMLAnchorElement} */ (el);
    const p = a.search ? Number(new URLSearchParams(a.search).get('page')) : NaN;
    if (Number.isFinite(p) && p > maxPage) maxPage = p;
  }
  const cur = Number(new URLSearchParams(location.search).get('page')) || 1;
  return { totalPage: Math.max(maxPage, cur), pageNum: cur };
}

/** DOM 兜底：汇总页集数按钮（文本「第 N 集」）+ h1 剧名 */
function domEpisodeItems() {
  const sname = (document.querySelector('h1')?.textContent || '').split(/\s*[·•]\s*/)[0].trim();
  const re = /第\s*(\d+)\s*集/;
  /** @type {Map<string, BatchItem>} */
  const out = new Map();
  for (const a of document.querySelectorAll('a[href^="/v/"]')) {
    const m = (a.getAttribute('href') || '').match(/^\/v\/([^/?#]+)/);
    if (!m) continue;
    const id = decodeURIComponent(m[1]);
    if (out.has(id)) continue;
    const em = (a.textContent || '').match(re);
    const name = em ? (sname ? `${sname} 第${em[1]}集` : em[0].replace(/\s+/g, '')) : id;
    out.set(id, { id, name });
  }
  return Array.from(out.values());
}

/**
 * @param {'series' | 'single'} mode
 * @param {number} limit
 * @returns {BatchItem[]}
 */
function harvestListingItems(mode, limit) {
  const pp = getPageProps();
  /** @type {BatchItem[]} */
  let items = [];
  if (mode === 'single') {
    const vids = Array.isArray(pp.videos) ? pp.videos : (Array.isArray(pp.list) ? pp.list : []);
    items = vids
      .filter((/** @type {any} */ v) => v && v.id && !('totalEpisodes' in v) && !('episodeCount' in v))
      .map((/** @type {any} */ v) => ({ id: String(v.id), name: String(v.nameZh || v.name || v.id) }));
    if (!items.length) items = domLinkItems('/v/');
  } else {
    const list = Array.isArray(pp.list) ? pp.list : [];
    items = list
      .filter((/** @type {any} */ s) => s && s.id && ('totalEpisodes' in s || 'episodeCount' in s))
      .map((/** @type {any} */ s) => ({ id: String(s.id), name: String(s.nameZh || s.name || s.id) }));
    if (!items.length) items = domLinkItems('/s/');
  }
  return Number.isFinite(limit) ? items.slice(0, limit) : items;
}

/** @returns {BatchItem[]} */
function harvestSeriesEpisodes() {
  const pp = getPageProps();
  const sname = pp.series?.nameZh || pp.series?.name || '';
  const eps = Array.isArray(pp.episodes) ? pp.episodes : [];
  const out = eps
    .filter((/** @type {any} */ e) => e && e.id)
    .map((/** @type {any} */ e) => ({ id: String(e.id), name: String(e.nameZh || e.name || (sname ? `${sname} 第${e.episode}集` : e.id)) }));
  if (!out.length) return domEpisodeItems();
  return out;
}

/** 汇总页剧名：优先 DOM h1（站点已移除 __NEXT_DATA__），回退 pageProps */
function seriesNameFromPage() {
  const h1 = (document.querySelector('h1')?.textContent || '').trim();
  if (h1) return h1;
  const pp = getPageProps();
  return pp.series?.nameZh || pp.series?.name || '';
}

/**
 * @param {number} page
 * @returns {string} pathname+search
 */
function listingPageUrl(page) {
  const u = new URL(location.href);
  u.searchParams.set('page', String(page));
  return u.pathname + u.search;
}

// pathname + search：翻页只改 query，防重复收割的标记必须带上 query。
function pageKey() {
  return location.pathname + location.search;
}

// 项数上限只约束列表层条目：剧集模式下 1 项 = 1 部剧集（其全部集都会下载），
// 单片模式下 1 项 = 1 个视频。
/**
 * @param {BatchState} b
 * @returns {number}
 */
function remainingSlots(b) {
  if (!b.limit) return Infinity;
  const used = b.mode === 'series'
    ? b.seriesQueue.length + (b.seriesTaken || 0)
    : b.done + b.failed.length + b.videoQueue.length + (b.current ? 1 : 0);
  return Math.max(0, b.limit - used);
}

/** @param {string} url */
function navTo(url) {
  clearTimeout(navTimer); // 防止连续 advance 排程多次跳转
  navTimer = setTimeout(() => { location.assign(url); }, NAV_DELAY);
}

// ---------------------------------------------------------------- 流水线推进

/**
 * @param {BatchState} b
 * @param {'self' | 'worker'} drive self = 当前标签页自驱（工作标签页内）；
 *   worker = 交给 SW 打开/复用后台标签页（面板/发起页调用，不劫持当前页）
 * @param {boolean} [reprime] worker 已停在目标页时踢其续跑（继续剩余场景：
 *   停止后被中止项回队首，expectedPath 与 worker 标签页 URL 相同，
 *   不重导航页面就不刷新、批次无人推进）
 */
async function advance(b, drive, reprime = false) {
  const v = b.videoQueue.shift();
  if (v) {
    b.current = v;
    b.note = `下载中：${v.name}`;
    b.expectedPath = `/v/${encodeURIComponent(v.id)}`; // 认领标记：只推进自己导航出的页面
    await saveBatch(b);
    if (drive === 'worker' && await requestWorker(b.expectedPath, reprime)) return;
    navTo(b.expectedPath);
    return;
  }
  const s = b.seriesQueue.shift();
  if (s) {
    b.current = null;
    b.note = `读取剧集：${s.name}`;
    b.expectedPath = `/s/${encodeURIComponent(s.id)}`;
    await saveBatch(b);
    if (drive === 'worker' && await requestWorker(b.expectedPath, reprime)) return;
    navTo(b.expectedPath);
    return;
  }
  const lp = b.listingPages.shift();
  if (lp) {
    b.current = null;
    b.note = `翻页收割：${lp}`;
    b.expectedPath = lp;
    await saveBatch(b);
    if (drive === 'worker' && await requestWorker(b.expectedPath, reprime)) return;
    navTo(b.expectedPath);
    return;
  }
  b.active = false;
  b.current = null;
  b.expectedPath = null;
  b.note = 'done';
  b.finishedAt = Date.now();
  await saveBatch(b);
  const fresh = b.done - (b.skipped || 0);
  hooks.toast?.(`连续下载完成：新下 ${fresh} · 跳过 ${b.skipped || 0} · 失败 ${b.failed.length}`);
  Logger.info('BATCH', `完成：新下 ${fresh}，跳过 ${b.skipped || 0}，失败 ${b.failed.length}`, b.failed);
}

/**
 * 让 SW 打开/复用后台工作标签页（认领制：标签页加载后自行续跑流水线）。
 * 失败必须可见并降级为当前页驱动——否则批次停在 active 却无人推进（静默失败）。
 * @param {string} url
 * @param {boolean} [reprime] 标签页已停在目标页时踢其续跑而非跳过
 * @returns {Promise<boolean>} 是否成功交给后台标签页
 */
async function requestWorker(url, reprime = false) {
  const r = await chrome.runtime.sendMessage({ type: 'rv-batch-open', url, reprime }).catch((e) => ({ ok: false, error: String(/** @type {any} */ (e)?.message || e) }));
  if (r?.ok) return true;
  const msg = `后台标签页打开失败（${r?.error || '无应答'}），改为当前页驱动`;
  Logger.warn('BATCH', msg);
  hooks.toast?.(msg, 4000);
  return false;
}

/** 面板"恢复后台下载"：为进行中的批次重新打开工作标签页（被手动关闭后恢复） */
/** @returns {Promise<void>} */
export async function spawnWorker() {
  const b = await getBatch();
  if (!b?.active || !b.expectedPath) throw new Error('没有进行中的批次');
  const r = await chrome.runtime.sendMessage({ type: 'rv-batch-open', url: b.expectedPath }).catch(() => null);
  if (!r?.ok) throw new Error(r?.error || '打开后台标签页失败');
}

// ---------------------------------------------------------------- 对外操作

/**
 * @param {'series' | 'single'} mode
 * @param {{ allPages?: boolean, limit?: number }} [scope]
 * @returns {Promise<void>}
 */
export async function startBatch(mode, scope = {}) {
  const det = detectListing();
  if (!det) throw new Error('当前页面不是列表页，无法连续下载');
  const limit = Number(scope.limit) > 0 ? Math.floor(Number(scope.limit)) : 0;
  /** @type {BatchState} */
  const b = {
    active: true,
    mode,
    limit,
    seriesTaken: 0,
    listingPages: [],
    seriesQueue: [],
    videoQueue: [],
    current: null,
    done: 0,
    failed: [],
    total: 0,
    note: '开始连续下载',
    lastHarvested: '',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (scope.allPages && det.totalPage > det.pageNum) {
    for (let p = det.pageNum + 1; p <= det.totalPage; p++) b.listingPages.push(listingPageUrl(p));
  }
  const take = limit || Infinity;
  if (mode === 'single') {
    const items = harvestListingItems('single', take);
    b.videoQueue.push(...items);
    b.total += items.length;
  } else {
    const items = harvestListingItems('series', take);
    b.seriesQueue.push(...items);
  }
  b.lastHarvested = pageKey();
  if (!b.videoQueue.length && !b.seriesQueue.length) {
    throw new Error(`当前页未检测到${mode === 'series' ? '剧集' : '单片'}条目`);
  }
  Logger.info('BATCH', `开始：视频队列 ${b.videoQueue.length}，剧集队列 ${b.seriesQueue.length}，翻页 ${b.listingPages.length}`);
  await saveBatch(b);
  await advance(b, 'worker'); // 后台标签页接管，当前页不被劫持
}

/** @returns {Promise<void>} */
export async function stopBatch() {
  Logger.info('BATCH', '收到停止指令');
  clearTimeout(navTimer); // 停止后不再跳页
  navTimer = 0;
  // 先落盘 inactive 再 abort：abort 触发的 onDownloadSettled 读到 inactive 会直接
  // early-return——被取消的项不会误入失败列表，也不会再 advance（修复竞态）
  const b = await getBatch();
  if (b) {
    if (b.current) {
      // 被中止的当前项未完成，放回队首
      b.videoQueue.unshift(b.current);
      b.current = null;
    }
    b.active = false;
    b.stoppedAt = Date.now();
    b.note = '已停止（可继续或重试失败项）';
    await saveBatch(b);
  }
  hooks.abort?.();
}

// 仅重试上次批次中的失败项（直接用已记录的视频 ID，不重新爬列表）
/** @returns {Promise<void>} */
export async function retryFailed() {
  const b = await getBatch();
  if (!b) throw new Error('没有历史批次记录');
  if (b.active) throw new Error('批次进行中，请先停止');
  if (!b.failed?.length) throw new Error('没有失败项');
  /** @type {BatchState} */
  const nb = {
    active: true,
    mode: b.mode || 'single',
    limit: 0,
    listingPages: [],
    seriesQueue: [],
    videoQueue: b.failed.map((f) => ({ id: f.id, name: f.name })),
    current: null,
    done: 0,
    failed: [],
    total: b.failed.length,
    note: `重试 ${b.failed.length} 个失败项`,
    lastHarvested: '',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  Logger.info('BATCH', `重试失败项：${nb.videoQueue.length} 个`);
  await saveBatch(nb);
  await advance(nb, 'worker');
}

// 重试本地媒体库账本中的失败项（跨会话持久——storage.local 批次在浏览器重启时清除，
// 而账本在本地服务里长期保留；成功后由生命周期上报自动改写为 complete）
/** @returns {Promise<void>} */
export async function retryLedgerFailed() {
  const b = await getBatch();
  if (b?.active) throw new Error('批次进行中，请先停止');
  const items = await queryLedger({ status: 'failed' });
  if (!items) throw new Error('本地媒体库服务未启动（server/start.bat）');
  if (!items.length) throw new Error('账本中没有失败项');
  /** @type {BatchState} */
  const nb = {
    active: true,
    mode: 'single',
    limit: 0,
    listingPages: [],
    seriesQueue: [],
    videoQueue: items.map((it) => ({ id: String(it.video_id), name: String(it.name || it.video_id) })),
    current: null,
    done: 0,
    failed: [],
    total: items.length,
    note: `账本重试 ${items.length} 个失败项`,
    lastHarvested: '',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  Logger.info('BATCH', `账本重试失败项：${nb.videoQueue.length} 个`);
  await saveBatch(nb);
  await advance(nb, 'worker');
}

// 停止后续跑剩余队列
/** @returns {Promise<void>} */
export async function resumeBatch() {
  const b = await getBatch();
  if (!b) throw new Error('没有历史批次记录');
  if (b.active) throw new Error('批次已在进行中');
  if (!b.videoQueue?.length && !b.seriesQueue?.length && !b.listingPages?.length) {
    throw new Error('没有剩余项可继续');
  }
  b.active = true;
  b.stoppedAt = null;
  b.note = '继续剩余项';
  await saveBatch(b);
  Logger.info('BATCH', `继续剩余：视频 ${b.videoQueue.length}，剧集 ${b.seriesQueue.length}，翻页 ${b.listingPages.length}`);
  await advance(b, 'worker', true);
}

// 每个下载结束后由 main 调用；返回是否属于连续下载任务。
/**
 * @param {{ ok: boolean, error?: string, skipped?: boolean }} result
 * @returns {Promise<boolean>} 是否属于连续下载任务
 */
export async function onDownloadSettled({ ok, error, skipped }) {
  const b = await getBatch();
  if (!b || !b.active || !b.current) return false;
  if (ok) {
    b.done += 1;
    if (skipped) b.skipped = (b.skipped || 0) + 1;
    Logger.info('BATCH', `完成 ${b.done}${skipped ? '（跳过，本地已存在）' : ''}：${b.current.name}`);
  } else {
    b.failed.push({ id: b.current.id, name: b.current.name, error: String(error || '下载失败').slice(0, 120) });
    Logger.warn('BATCH', `跳过失败项：${b.current.name}（${error}）`);
  }
  b.current = null;
  await advance(b, 'self'); // 下载发生在工作标签页内，自驱推进
  return true;
}

// 每次页面加载后调用：若存在进行中的任务则继续流水线。
/** @returns {Promise<void>} */
export async function maybeContinueBatch() {
  if (continuing) return;
  const b = await getBatch();
  if (!b || !b.active) return;
  continuing = true;
  try {
    const path = location.pathname;
    Logger.info('BATCH', `续跑 @${path}：${b.note || ''}`);
    // 认领制：批次只推进自己导航出来的页面；用户手动打开的页面与 expectedPath
    // 不匹配 → 批次原地暂停（面板可停止/继续），不跳页、不收割、不污染队列
    if (b.expectedPath && b.expectedPath !== pageKey()) {
      Logger.info('BATCH', `非流水线页面，批次暂停（等待 ${b.expectedPath}）`);
      return;
    }
    if (path.startsWith('/v/')) {
      const id = videoIdFromPath();
      if (b.current && b.current.id === id) {
        b.note = `下载中：${b.current.name}`;
        await saveBatch(b);
        await hooks.downloadCurrent?.();
        return;
      }
      await advance(b, 'self'); // 队列外的播放页，直接推进
      return;
    }
    if (path.startsWith('/s/') && b.mode === 'series') {
      if (b.lastHarvested === pageKey()) { await advance(b, 'self'); return; } // 防刷新重复收割
      const eps = harvestSeriesEpisodes();
      b.seriesTaken = (b.seriesTaken || 0) + 1;
      b.videoQueue.push(...eps); // 剧集中的每一集都下载，不受列表项数上限约束
      b.total += eps.length;
      b.lastHarvested = pageKey();
      const sname = seriesNameFromPage() || path;
      b.note = `剧集「${sname}」共 ${eps.length} 集`;
      await saveBatch(b);
      await advance(b, 'self');
      return;
    }
    // 列表根页
    const det = detectListing();
    if (!det) {
      b.active = false;
      b.note = 'error: 无法识别的页面';
      await saveBatch(b);
      hooks.toast?.('连续下载中断：页面无法识别');
      return;
    }
    const take = remainingSlots(b);
    if (take <= 0) {
      b.listingPages = [];
      await saveBatch(b);
      await advance(b, 'self');
      return;
    }
    if (b.lastHarvested === pageKey() && (b.videoQueue.length || b.seriesQueue.length)) {
      await advance(b, 'self'); // 防刷新重复收割
      return;
    }
    if (b.mode === 'single') {
      const items = harvestListingItems('single', take);
      b.videoQueue.push(...items);
      b.total += items.length;
    } else {
      const items = harvestListingItems('series', take);
      b.seriesQueue.push(...items);
    }
    b.lastHarvested = pageKey();
    b.note = `收割列表 ${path}（第 ${det.pageNum}/${det.totalPage} 页）`;
    await saveBatch(b);
    await advance(b, 'self');
  } catch (e) {
    Logger.error('BATCH', `续跑失败: ${errText(e)}`);
  } finally {
    // 复位认领闸门：否则本页内后续（如 SPA 路由后重试）永远无法再认领
    continuing = false;
  }
}
