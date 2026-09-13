import { RATES } from './core/constants.js';
import { Logger } from './core/logger.js';
import { errText, isAbortError, pageVideo, sanitizeName, toAbsolute } from './core/utils.js';
import { downloadQuality } from './hls/downloader.js';
import { cancelActiveSave, saveSmallFile } from './net/save.js';
import { isPlaylistUrl, parseMasterPlaylist, parseMediaPlaylist, pickVariant, playlistCandidates } from './hls/playlist.js';
import { fetchBuffer, fetchText } from './net/http.js';
import { collectSniffedFromPerformance, installPageHookListener, sniffedUrls } from './net/sniffer.js';
import { getVideoInfoFresh, videoIdFromPath } from './site/video-info.js';
import { loadSettings, saveSetting, state } from './state.js';
import * as batch from './features/batch.js';
import { endBoost, handleKeyDown, handleKeyUp, initBoost, updateActiveRate } from './features/boost.js';
import * as hud from './ui/hud.js';

// ---------------------------------------------------------------------------
// Side panel bridge: the content script owns all state; the panel is a remote
// control that pulls snapshots (rv-get-state), receives pushes (rv-state),
// and sends commands (rv-cmd).
// ---------------------------------------------------------------------------

function snapshot() {
  return {
    path: location.pathname,
    booting: state.booting,
    ready: state.ready,
    page: state.page ? { name: state.page.name, duration: state.page.duration || 0 } : null,
    qualities: state.qualities.map((q) => ({
      label: q.label, url: q.url, height: q.height || 0, duration: q.duration || 0, segments: q.segments || 0,
    })),
    selectedHeight: currentStream()?.height || 0,
    qualityHeight: state.qualityHeight,
    download: state.download ? { ...state.download } : null,
    holdBoost: state.holdBoost,
    holdRate: state.holdRate,
    listing: batch.detectListing(),
  };
}

function pushState() {
  chrome.runtime.sendMessage({ type: 'rv-state', state: snapshot() }).catch(() => {});
}

function requestOpenPanel() {
  chrome.runtime.sendMessage({ type: 'rv-open-panel' })
    .then((res) => { if (res && res.ok === false) hud.toast('请从浏览器工具栏图标打开侧边栏'); })
    .catch(() => hud.toast('请从浏览器工具栏图标打开侧边栏'));
}

async function togglePip() {
  const v = pageVideo();
  if (!v || !document.pictureInPictureEnabled) return hud.toast('当前浏览器不支持画中画');
  try {
    if (document.pictureInPictureElement) await document.exitPictureInPicture();
    else await v.requestPictureInPicture();
  } catch {
    hud.toast('画中画失败', 4000);
  }
}

function currentStream() {
  return pickVariant(state.qualities, state.qualityHeight);
}

/** 懒加载变体的媒体列表信息（时长/分段数，仅展示用；下载时总是重新拉取） */
/** @param {import('./hls/playlist.js').Variant} v */
async function fillMediaInfo(v) {
  if (v.segments) return;
  try {
    const mediaText = await fetchText(v.url);
    const media = parseMediaPlaylist(mediaText, v.url);
    v.duration = media.duration || 0;
    v.segments = media.segments.length;
  } catch { v.duration = 0; }
}

// 查询 SW：目标文件是否已在本地（自定义目录句柄直查 .mp4/.ts 双查）
/**
 * @param {string} filename
 * @returns {Promise<{ exists: boolean, noHandle?: boolean }>}
 */
function checkDownloaded(filename) {
  return chrome.runtime.sendMessage({ type: 'rv-file-exists', filename })
    .then((r) => ({ exists: !!r?.exists, noHandle: !!r?.noHandle }))
    .catch(() => ({ exists: false }));
}

// 入口同步守卫：双击/连点（或面板点击与批次触发同时到达）时只有一个调用能穿过，
// 否则两个调用会都越过 state.download?.running 检查，同文件被下载两遍
async function startDownload() {
  if (state.starting) return false;
  state.starting = true;
  try {
    return await startDownloadInner();
  } finally {
    state.starting = false;
  }
}

async function startDownloadInner() {
  let quality = currentStream();
  if (!quality && !state.booting) {
    await bootVideo(true);
    quality = currentStream();
  }
  if (!quality || state.download?.running) return false;
  // 剧集视频归入以剧名命名的子目录（Chrome 的 download 属性支持子目录并自动创建）
  const seriesDir = state.page?.seriesName ? `${sanitizeName(state.page.seriesName)}/` : '';
  const filename = `${seriesDir}${sanitizeName(state.page?.name || 'rouvideo')}.mp4`;
  const verdict = await checkDownloaded(filename);
  if (verdict.noHandle) {
    hud.toast('请先在侧边栏选择下载目录', 4000);
    state.download = { running: false, finished: false, error: '未选择下载目录', errorCode: 'NOHANDLE' };
    pushState();
    return false;
  }
  if (verdict.exists) {
    Logger.info('DL', `本地已存在，跳过：${filename}`);
    hud.toast('本地已存在，已跳过下载');
    state.download = { running: false, finished: true, pct: 100, skipped: true, filename };
    pushState();
    saveCover(state.page); // 封面仍补齐（覆盖写，代价极小）
    return true;
  }
  const ctrl = new AbortController();
  state.abort = ctrl;
  state.download = { running: true, finished: false, done: 0, total: 0, bytes: 0, speed: 0, eta: 0, pct: 0 };
  pushState();
  try {
    const result = await downloadQuality(quality, filename, (info) => {
      state.download = { running: true, finished: false, ...info };
      pushState();
    }, ctrl.signal);
    if (result.mode === 'skip') {
      // 与 begin 双查竞态命中：按已存在处理
      state.download = { running: false, finished: true, pct: 100, skipped: true, filename };
      pushState();
      await saveCover(state.page);
      hud.toast('本地已存在，已跳过下载');
      return true;
    }
    state.download = {
      running: false, finished: true, pct: 100,
      bytes: result.bytes || state.download.bytes || 0,
      filename: result.filename || filename,
    };
    await saveCover(state.page);
    hud.toast(result.note || '下载完成');
    return true;
  } catch (err) {
    const aborted = isAbortError(err);
    const code = /** @type {any} */ (err)?.code;
    const msg = aborted ? '已取消'
      : code === 'REAUTH' ? '下载目录未授权，请在侧边栏重新授权'
      : code === 'NOHANDLE' ? '请先在侧边栏选择下载目录'
      : (errText(err) || '下载失败');
    hud.toast(msg, aborted ? 1800 : 4000); // 错误信息留足阅读时间
    if (state.download) {
      state.download.running = false;
      state.download.finished = false;
      state.download.error = aborted ? 'aborted' : msg;
      state.download.errorCode = code;
    }
    return false;
  } finally {
    if (state.abort === ctrl) state.abort = null; // 只清自己的 controller，避免清掉新路由上刚开始的下载
    pushState();
  }
}

// 封面随视频一起保存：剧集 → 剧名/剧名.jpg（每集覆盖写同一个文件，天然只留一张，
// 且与文件夹同名会被 Windows 当作文件夹缩略图）；单片 → 视频名.jpg。
/** @param {Uint8Array} u8 @returns {'jpg' | 'png' | 'webp'} */
function sniffImageExt(u8) {
  if (u8.length > 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'jpg';
  if (u8.length > 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'png';
  if (u8.length > 12 && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return 'webp';
  return 'jpg';
}

/** @param {import('./site/video-info.js').PageInfo | null} page */
async function saveCover(page) {
  try {
    const isSeries = !!page?.seriesName;
    const coverUrl = isSeries ? page?.seriesCoverUrl : page?.coverUrl;
    if (!coverUrl) return;
    const buf = new Uint8Array(await fetchBuffer(coverUrl));
    if (!buf.length) return;
    const ext = sniffImageExt(buf);
    const base = isSeries
      ? `${sanitizeName(page.seriesName)}/${sanitizeName(page.seriesName)}`
      : sanitizeName(page?.name || 'rouvideo');
    const r = await saveSmallFile(buf, `${base}.${ext}`);
    if (!r.ok) Logger.warn('COVER', `封面保存失败: ${r.error}`);
  } catch (e) {
    Logger.warn('COVER', `封面下载失败: ${errText(e)}`);
  }
}

// 连续下载专用：等待解析完成 → 下载 → 把结果交回编排器推进队列。
async function batchDownloadCurrent() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (currentStream()) break;
    if (!state.booting) await bootVideo(true);
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!currentStream()) {
    await batch.onDownloadSettled({ ok: false, error: '解析超时' });
    return;
  }
  const ok = await startDownload();
  const errMsg = ok ? '' : (state.download?.error === 'aborted' ? '已取消' : (state.download?.error || '下载失败'));
  await batch.onDownloadSettled({ ok, error: errMsg, code: state.download?.errorCode });
}

async function bootVideo(force = false) {
  if (state.booting) return;
  if (state.qualities.length && !force) return;
  state.booting = true;
  state.page = await getVideoInfoFresh();
  pushState();
  const videoId = state.page?.id || videoIdFromPath();
  try {
    const m3u8Url = state.page?.masterM3u8;
    collectSniffedFromPerformance();
    /** @type {string[]} */
    const candidates = [];
    const addCandidate = (/** @type {string | undefined} */ u) => { if (u && !candidates.includes(u)) candidates.push(u); };
    for (const url of sniffedUrls) {
      if (isPlaylistUrl(url)) addCandidate(url);
    }
    if (m3u8Url) {
      for (const url of playlistCandidates(m3u8Url)) addCandidate(url);
    }
    if (videoId) addCandidate(toAbsolute(`/api/hls/${videoId}`));
    if (!candidates.length) throw new Error('无法获取播放地址');

    let text = null;
    let usedUrl = null;
    for (const url of candidates) {
      try {
        text = await fetchText(url);
        if (text && (text.includes('#EXTM3U') || text.includes('#EXTINF'))) {
          usedUrl = url;
          break;
        }
        text = null;
      } catch (e) {
        Logger.warn('BOOT', `播放列表失败: ${errText(e)}`);
      }
    }

    if (!text) {
      const videos = document.querySelectorAll('video');
      for (const v of videos) {
        const src = v.currentSrc || v.src;
        if (src && !src.startsWith('blob:')) {
          state.qualities = [{
            label: '视频源', url: src, prefix: src,
            resolution: '', bandwidth: 0, height: 0,
            duration: v.duration || state.page?.duration || 0, segments: 0,
          }];
          state.booting = false;
          state.ready = true;
          pushState();
          return;
        }
      }
    }

    if (!text) throw new Error('无法获取播放列表');

    if (text.includes('#EXT-X-STREAM-INF')) {
      const variants = parseMasterPlaylist(text, /** @type {string} */ (usedUrl));
      if (!variants.length) throw new Error('播放列表为空');
      state.qualities = variants;
      pushState(); // 先亮出全部档位（时长/分段数随后补齐）
      const pick = pickVariant(variants, state.qualityHeight);
      if (pick) await fillMediaInfo(pick);
    } else if (text.includes('#EXTINF')) {
      const media = parseMediaPlaylist(text, /** @type {string} */ (usedUrl));
      if (!media.segments.length) throw new Error('播放列表为空');
      state.qualities = [{
        label: 'default',
        url: /** @type {string} */ (usedUrl),
        prefix: /** @type {string} */ (usedUrl).replace(/[^/]+$/, ''),
        resolution: '', bandwidth: 0, height: 0,
        duration: media.duration || state.page?.duration || 0,
        segments: media.segments.length,
      }];
    } else {
      throw new Error('无法识别的播放列表格式');
    }
    pushState();
  } catch (err) {
    Logger.error('BOOT', `解析失败: ${errText(err)}`);
    if (force) hud.toast(`解析失败: ${errText(err)}`, 4000);
    pushState();
  } finally {
    state.booting = false;
    state.ready = true;
    pushState();
  }
}

function resetForRoute() {
  endBoost();
  state.abort?.abort(); // 换页即放弃进行中的下载，避免僵尸下载继续占资源并静默落盘
  state.qualities = [];
  state.page = null;
  state.download = null;
  state.abort = null;
  state.booting = false;
  sniffedUrls.clear();
  if (location.pathname.startsWith('/v/')) bootVideo(true);
  else pushState();
}

function watchRoute() {
  const onChange = () => {
    if (location.pathname === state.lastPath) return;
    state.lastPath = location.pathname;
    resetForRoute();
  };
  // The MAIN-world page hook reports pushState/replaceState navigations…
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.__rvHook !== 1 || d.kind !== 'route') return;
    queueMicrotask(onChange);
  });
  // …and polling + popstate cover everything else.
  window.addEventListener('popstate', onChange);
  setInterval(onChange, 800);
}

/** @param {KeyboardEvent} e */
function onKeyDown(e) {
  if (e.altKey && (e.key === 'd' || e.key === 'D')) {
    e.preventDefault();
    requestOpenPanel();
    return;
  }
  handleKeyDown(e);
}

/** @param {KeyboardEvent} e */
function onKeyUp(e) {
  handleKeyUp(e);
}

/**
 * @param {string} cmd
 * @param {any} [value]
 */
function runCommand(cmd, value) {
  if (cmd === 'download') startDownload();
  else if (cmd === 'abort') { state.abort?.abort(); cancelActiveSave(); } // 下载/保存两阶段都可取消
  else if (cmd === 'rescan') { hud.toast('正在解析…'); bootVideo(true); }
  else if (cmd === 'pip') togglePip();
  else if (cmd === 'batch-start') {
    batch.startBatch(value?.mode, value).catch((e) => hud.toast(e.message, 4000));
  }   else if (cmd === 'batch-stop') {
    batch.stopBatch().then(() => hud.toast('已停止（记录已保留）'));
  } else if (cmd === 'batch-retry') {
    batch.retryFailed().catch((e) => hud.toast(e.message, 4000));
  } else if (cmd === 'batch-resume') {
    batch.resumeBatch().catch((e) => hud.toast(e.message, 4000));
  } else if (cmd === 'batch-clear') {
    batch.clearBatch().then(() => hud.toast('已清除批次记录'));
  }
  else if (cmd === 'toggle-boost') {
    state.holdBoost = !state.holdBoost;
    saveSetting('holdBoost', state.holdBoost);
    if (!state.holdBoost) endBoost();
    pushState();
  } else if (cmd === 'rate') {
    const n = Number(value);
    if (!RATES.includes(n)) return;
    state.holdRate = n;
    saveSetting('holdRate', n);
    updateActiveRate(n);
    pushState();
  } else if (cmd === 'quality') {
    // 清晰度偏好：≤所选档取最高（pickVariant），批量下载沿用同一偏好
    const h = Math.max(0, Number(value) || 0);
    state.qualityHeight = h;
    saveSetting('qualityHeight', h);
    const pick = currentStream();
    if (pick) fillMediaInfo(pick).then(pushState);
    else pushState();
  } else if (cmd === 'batch-spawn') {
    batch.spawnWorker().catch((e) => hud.toast(e.message, 4000));
  }
}

batch.initBatch({
  toast: hud.toast,
  abort: () => state.abort?.abort(),
  downloadCurrent: batchDownloadCurrent,
});

function init() {
  hud.mount();
  watchRoute();
  initBoost();
  if (location.pathname.startsWith('/v/')) {
    bootVideo();
    setTimeout(() => { if (!state.qualities.length) bootVideo(); }, 2000);
    setTimeout(() => { if (!state.qualities.length) bootVideo(); }, 5000);
  } else {
    pushState();
  }
  // 若存在进行中的连续下载任务，继续流水线（列表页收割 / 汇总页收割 / 播放页下载）
  setTimeout(() => { batch.maybeContinueBatch(); }, 1500);
}

async function main() {
  await loadSettings();
  Logger.info('BOOT', `肉视频助手扩展已加载 (MV3, v${chrome.runtime.getManifest().version})`);
  installPageHookListener();
  collectSniffedFromPerformance();
  setTimeout(collectSniffedFromPerformance, 2000);
  setTimeout(collectSniffedFromPerformance, 5000);

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'rv-get-state') {
      sendResponse(snapshot());
      return false;
    }
    if (message?.type === 'rv-cmd') {
      runCommand(message.cmd, message.value);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}

main();
