// Service worker：侧边栏开关、offscreen 生命周期、保存/封面消息转发、
// 已下载判定（本地媒体库服务 → 下载历史校验回退）、本地库登记中转、
// 连续下载后台标签页管理。

const OFFSCREEN_URL = 'src/offscreen.html';
const BATCH_KEY = 'rv-hud:batch';
const BATCH_TAB_KEY = 'rv-batch-tab';
const LEDGER_BASE = 'http://127.0.0.1:17321';

// ---------------------------------------------------------------- 侧边栏

// Toolbar icon click opens the side panel automatically.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// FAB click / Alt+D in the page ask us to open the side panel. The
// sidePanel.open() call must happen synchronously inside this listener —
// the user gesture is lost after the first await.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'rv-open-panel' && sender.tab) {
    chrome.sidePanel.open({ windowId: sender.tab.windowId })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String((/** @type {any} */ (err))?.message || err) }));
    return true;
  }
  return false;
});

// Batch state lives in storage.local (content scripts can't use the session
// area); clear leftovers on browser start so an interrupted batch never
// resumes unexpectedly.
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.remove(BATCH_KEY).catch(() => {});
  chrome.storage.session.remove(BATCH_TAB_KEY).catch(() => {});
});

// ---------------------------------------------------------------- offscreen

/** @type {Promise<void> | null} */
let ensureChain = null;

async function ensureOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument()) return;
  } catch {
    // hasDocument 不可用时直接尝试创建，已存在会抛错，忽略即可
  }
  if (!ensureChain) {
    ensureChain = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: '将下载的视频数据流式暂存到扩展私有存储（OPFS），完成后交给 chrome.downloads 落盘',
    }).catch((e) => {
      if (!/single offscreen|Only a single/.test(String((/** @type {any} */ (e))?.message || e))) throw e;
    }).finally(() => { ensureChain = null; });
  }
  await ensureChain;
}

// ---------------------------------------------------------------- 下载中转与已下载判定

/**
 * 等待下载进入终态。
 * @param {number} downloadId
 * @param {number} timeoutMs
 * @returns {Promise<chrome.downloads.DownloadItem | null>}
 */
function waitDownload(downloadId, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      chrome.downloads.onChanged.removeListener(listener);
      try { const [it] = await chrome.downloads.search({ id: downloadId }); resolve(it || null); } catch { resolve(null); }
    }, timeoutMs);
    const listener = async (/** @type {chrome.downloads.DownloadDelta} */ delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      const st = delta.state.current;
      if (st !== 'complete' && st !== 'interrupted') return;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(listener);
      try { const [it] = await chrome.downloads.search({ id: downloadId }); resolve(it || null); } catch { resolve(null); }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

/**
 * 经 chrome.downloads 落盘（objectURL / dataURL）。
 * @param {string} url
 * @param {string} filename 可含子目录
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function downloadToDisk(url, filename) {
  if (!url || !filename) return { ok: false, error: '缺少落盘参数' };
  const downloadId = await chrome.downloads.download({
    url, filename, saveAs: false, conflictAction: 'overwrite',
  });
  // 大文件 objectURL → 磁盘的复制可能耗时，给足窗口
  const item = await waitDownload(downloadId, 15 * 60 * 1000);
  if (!item || item.state !== 'complete') {
    try { await chrome.downloads.removeFile(downloadId); } catch {}
    try { await chrome.downloads.erase({ id: downloadId }); } catch {}
    return { ok: false, error: '落盘中断' };
  }
  // 本地媒体库登记（fire-and-forget，服务未启动等失败无害——下次扫描自会补齐）
  if (item.filename) {
    ledgerPost('/api/files', { absPath: item.filename, size: item.bytesReceived || 0 }).catch(() => {});
  }
  return { ok: true };
}

// ---------------------------------------------------------------- 本地媒体库（server/DESIGN.md）

/** POST JSON 到本地服务。 @param {string} path @param {any} body @returns {Promise<Response>} */
function ledgerPost(path, body) {
  return fetch(LEDGER_BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * 本地服务 exists 查询（磁盘实况，权威判定层）。
 * 服务端账本优先：vid（video_id）精确命中不受站点改名影响；filename 回退。
 * @param {string} rel 完整相对路径（已归一化小写）
 * @param {string} [vid] 站点视频 id（空串 = 仅按 rel 匹配）
 * @returns {Promise<{ exists: boolean, matches: { path: string, type: string, size: number }[] } | null>} null = 服务不可用
 */
async function ledgerExists(rel, vid = '') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300);
  try {
    const q = `rel=${encodeURIComponent(rel)}${vid ? `&vid=${encodeURIComponent(vid)}` : ''}`;
    const r = await fetch(`${LEDGER_BASE}/api/exists?${q}`, { signal: ctrl.signal });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || typeof j.exists !== 'boolean') return null;
    return { exists: j.exists, matches: Array.isArray(j.matches) ? j.matches : [] };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 已下载判定（三层链第一二层的实现）：本地媒体库服务优先，
 * 不可用（未启动/超时）回退 chrome.downloads 历史校验。
 * @param {string} filename 可含子目录
 * @param {string} [vid] 站点视频 id（透传服务端账本精确命中）
 * @returns {Promise<{ exists: boolean, matches: { path: string, type: string, size: number }[] }>}
 */
async function fileExists(filename, vid = '') {
  const rel = filename.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  const local = await ledgerExists(rel, vid);
  if (local) return local;
  return { exists: await fileExistsLegacy(filename), matches: [] };
}

/**
 * 回退层：下载历史精确校验（完整相对路径优先，basename 回退）。
 * 注意：不能信任 d.exists——该字段在浏览器重启后可能陈旧为 false
 * （下载目录在非系统/可移动盘时尤甚），文件明明在磁盘上也会被误判未下载而重复下载。
 * ≤v1.7 旧管线（FS Access 落盘）的视频没有下载历史，但封面 jpg/png/webp 走
 * chrome.downloads 且只在视频成功后保存——封面命中即可作为"已下载"的代理证据。
 * @param {string} filename 可含子目录
 * @returns {Promise<boolean>}
 */
async function fileExistsLegacy(filename) {
  const rel = filename.replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  const basename = /** @type {string} */ (rel.split('/').pop());
  const stemBase = basename.replace(/\.[a-z0-9]+$/, '');
  if (!stemBase) return false;
  try {
    const items = await chrome.downloads.search({ query: [stemBase], limit: 200 });
    return items.some((d) => {
      if (d.state !== 'complete') return false;
      const fn = (d.filename || '').replace(/\\/g, '/').toLowerCase();
      if (fn.endsWith('/' + rel) || fn.endsWith(basename)) return true; // 视频本体（忽略陈旧 exists）
      // 同名封面代理：不同视频恰好同名时可能误报，代价可接受（重试可单发）
      return /\.(jpe?g|png|webp)$/.test(fn) && (fn.split('/').pop() || '').replace(/\.[a-z0-9]+$/, '') === stemBase;
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 消息路由

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  // 保存会话开始：确保 offscreen 并转发（元数据小，SW 经手无妨；数据分块不经过 SW）
  if (message.type === 'rv-save-begin') {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({
        to: 'os', type: 'os-save-begin',
        saveId: message.saveId, filename: message.filename,
        fingerprint: message.fingerprint, segTotal: message.segTotal,
      }))
      .then((r) => sendResponse(r || { ok: false, error: 'offscreen 无应答' }))
      .catch((e) => sendResponse({ ok: false, error: String((/** @type {any} */ (e))?.message || e) }));
    return true;
  }

  // OPFS 完成文件 / 封面：objectURL 或 dataURL → chrome.downloads
  if (message.type === 'os-url') {
    downloadToDisk(String(message.dataUrl || message.url || ''), String(message.filename || ''))
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String((/** @type {any} */ (e))?.message || e) }));
    return true;
  }

  // 封面等小文件直写：data URL 直接落盘（不经 offscreen）
  if (message.type === 'rv-save-cover') {
    downloadToDisk(`data:application/octet-stream;base64,${String(message.b64 || '')}`, String(message.filename || ''))
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String((/** @type {any} */ (e))?.message || e) }));
    return true;
  }

  // 已下载判定（本地媒体库服务 → 下载历史回退，无需 offscreen）
  if (message.type === 'rv-file-exists') {
    fileExists(String(message.filename || ''), String(message.videoId || ''))
      .then((r) => sendResponse(r))
      .catch(() => sendResponse({ exists: false, matches: [] }));
    return true;
  }

  // 本地媒体库：下载生命周期上报（内容脚本不能直连 127.0.0.1，经 SW 中转）
  if (message.type === 'rv-ledger-report') {
    ledgerPost('/api/downloads', message.payload || {})
      .then((r) => sendResponse({ ok: r.ok }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  // 本地媒体库：账本查询（失败列表驱动重试）
  if (message.type === 'rv-ledger-query') {
    const q = new URLSearchParams();
    if (message.opt?.status) q.set('status', String(message.opt.status));
    if (message.opt?.site) q.set('site', String(message.opt.site));
    fetch(`${LEDGER_BASE}/api/downloads?${q.toString()}`)
      .then((r) => r.json())
      .then((j) => sendResponse({ items: Array.isArray(j?.items) ? j.items : [] }))
      .catch(() => sendResponse({ items: [] }));
    return true;
  }

  // 连续下载：打开/复用后台工作标签页（reprime = 继续剩余：踢闲置页面续跑）
  if (message.type === 'rv-batch-open') {
    openBatchTab(String(message.url || ''), !!message.reprime)
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String((/** @type {any} */ (e))?.message || e) }));
    return true;
  }

  return false;
});

// ---------------------------------------------------------------- 连续下载后台标签页

/**
 * 打开或复用后台工作标签页（标签页 id 存 storage.session，SW 重启不丢）。
 * expectedPath 为站内相对路径，此处统一绝对化；已在目标页时不重导航
 * （避免"恢复"按钮打断进行中的下载）；reprime 场景（继续剩余）例外——
 * 标签页停在目标页但批次刚从停止恢复、页面闲置无人推进，发 batch-continue
 * 踢其续跑，内容脚本失联（未注入/崩溃）则强制重导航兜底。
 * @param {string} url
 * @param {boolean} [reprime]
 * @returns {Promise<{ ok: boolean, tabId?: number, error?: string }>}
 */
async function openBatchTab(url, reprime = false) {
  if (!url) return { ok: false, error: '缺少目标地址' };
  const abs = url.startsWith('http') ? url : `https://rou.video${url}`;
  try {
    const raw = /** @type {Record<string, any>} */ (await chrome.storage.session.get(BATCH_TAB_KEY));
    const tabId = raw[BATCH_TAB_KEY];
    if (tabId != null) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && (tab.url === abs || tab.pendingUrl === abs)) {
          if (reprime) {
            const pong = await chrome.tabs.sendMessage(tabId, { type: 'rv-cmd', cmd: 'batch-continue' }).catch(() => null);
            if (!pong) await chrome.tabs.update(tabId, { url: abs });
          }
          return { ok: true, tabId };
        }
        await chrome.tabs.update(tabId, { url: abs });
        return { ok: true, tabId };
      } catch { /* 标签页已不在，开新的 */ }
    }
    const tab = await chrome.tabs.create({ url: abs, active: false });
    await chrome.storage.session.set({ [BATCH_TAB_KEY]: tab.id });
    return { ok: true, tabId: tab.id };
  } catch (e) {
    return { ok: false, error: String((/** @type {any} */ (e))?.message || e) };
  }
}

/** 关闭后台工作标签页（批次终态时调用） */
async function closeBatchTab() {
  try {
    const raw = /** @type {Record<string, any>} */ (await chrome.storage.session.get(BATCH_TAB_KEY));
    const tabId = raw[BATCH_TAB_KEY];
    await chrome.storage.session.remove(BATCH_TAB_KEY);
    if (tabId != null) await chrome.tabs.remove(tabId).catch(() => {});
  } catch {}
}

// 批次进入终态（完成/停止）→ 关闭后台标签页
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[BATCH_KEY]) return;
  const wasActive = !!(/** @type {any} */ (changes[BATCH_KEY].oldValue)?.active);
  const nowActive = !!(/** @type {any} */ (changes[BATCH_KEY].newValue)?.active);
  if (wasActive && !nowActive) closeBatchTab();
});

// 用户手动关闭了工作标签页 → 清掉记录（批次本身暂停，面板可一键恢复）
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.get(BATCH_TAB_KEY).then((raw) => {
    if (/** @type {Record<string, any>} */ (raw)[BATCH_TAB_KEY] === tabId) {
      chrome.storage.session.remove(BATCH_TAB_KEY).catch(() => {});
    }
  }).catch(() => {});
});
