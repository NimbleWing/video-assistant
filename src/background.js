// Service worker：侧边栏开关、offscreen 生命周期、保存/封面消息转发、
// 已下载判定（账本 + 下载历史校验）、连续下载后台标签页管理。

const OFFSCREEN_URL = 'src/offscreen.html';
const BATCH_KEY = 'rv-hud:batch';
const BATCH_TAB_KEY = 'rv-batch-tab';

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
  return { ok: true };
}

/**
 * 已下载判定：下载历史精确校验（basename 匹配且文件仍在）。
 * @param {string} filename 可含子目录
 * @returns {Promise<boolean>}
 */
async function fileExists(filename) {
  const basename = /** @type {string} */ (filename.split(/[\\/]/).pop());
  try {
    const items = await chrome.downloads.search({ query: [basename], limit: 200 });
    return items.some((d) => d.state === 'complete' && d.exists !== false
      && (d.filename || '').endsWith(basename));
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

  // 已下载判定（账本 + 下载历史，无需 offscreen）
  if (message.type === 'rv-file-exists') {
    fileExists(String(message.filename || ''))
      .then((exists) => sendResponse({ exists }))
      .catch(() => sendResponse({ exists: false }));
    return true;
  }

  // 连续下载：打开/复用后台工作标签页
  if (message.type === 'rv-batch-open') {
    openBatchTab(String(message.url || ''))
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
 * （避免"恢复"按钮打断进行中的下载）。
 * @param {string} url
 * @returns {Promise<{ ok: boolean, tabId?: number, error?: string }>}
 */
async function openBatchTab(url) {
  if (!url) return { ok: false, error: '缺少目标地址' };
  const abs = url.startsWith('http') ? url : `https://rou.video${url}`;
  try {
    const raw = /** @type {Record<string, any>} */ (await chrome.storage.session.get(BATCH_TAB_KEY));
    const tabId = raw[BATCH_TAB_KEY];
    if (tabId != null) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && (tab.url === abs || tab.pendingUrl === abs)) return { ok: true, tabId };
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
