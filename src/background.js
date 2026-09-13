// Service worker：侧边栏开关、offscreen 生命周期、保存/封面消息转发、
// 已下载判定（自定义目录句柄直查）、连续下载后台标签页管理。

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

// 旧版遗物清理（1.8.0 起已下载判定改为句柄直查，下载账本废弃）
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.remove('rv-hud:dl-ledger').catch(() => {});
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
      justification: '将下载的视频数据流式写入用户选择的下载目录（File System Access）',
    }).catch((e) => {
      if (!/single offscreen|Only a single/.test(String((/** @type {any} */ (e))?.message || e))) throw e;
    }).finally(() => { ensureChain = null; });
  }
  await ensureChain;
}

// ---------------------------------------------------------------- 消息转发与已下载判定

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

  // 封面等小文件直写
  if (message.type === 'rv-save-cover') {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ to: 'os', type: 'os-write-file', filename: message.filename, b64: message.b64 }))
      .then((r) => sendResponse(r || { ok: false, error: 'offscreen 无应答' }))
      .catch((e) => sendResponse({ ok: false, error: String((/** @type {any} */ (e))?.message || e) }));
    return true;
  }

  // 已下载判定：自定义目录句柄直查（无句柄 = 尚未选择下载目录）
  if (message.type === 'rv-file-exists') {
    (async () => {
      const flag = (/** @type {Record<string, any>} */ (await chrome.storage.local.get('rv-hud:fsdir')))['rv-hud:fsdir'];
      if (!flag?.name) return { exists: false, noHandle: true };
      await ensureOffscreen();
      const r = await chrome.runtime.sendMessage({ to: 'os', type: 'os-file-exists', filename: String(message.filename || '') });
      if (r?.handled) return { exists: !!r.exists };
      if (r?.code === 'NOHANDLE') return { exists: false, noHandle: true };
      return { exists: false, code: r?.code };
    })()
      .then((r) => sendResponse(r))
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

// 批次进入终态（完成/停止/授权失效暂停）→ 关闭后台标签页
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
