// Service worker：侧边栏开关、offscreen 生命周期、下载中转（downloads API 支持子目录）。

const OFFSCREEN_URL = 'src/offscreen.html';
const BATCH_KEY = 'rv-hud:batch';

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
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  return false;
});

// Batch downloads save one file per video without user gestures; allow
// automatic multiple downloads on rou.video as a fallback for the anchor
// save path. Idempotent — safe to run on every worker boot.
async function allowAutoDownloads() {
  try {
    await chrome.contentSettings.automaticDownloads.set({
      primaryPattern: 'https://rou.video/*',
      setting: 'allow',
    });
  } catch (e) {
    console.warn('[RouVideo] 设置自动多文件下载权限失败', e?.message || e);
  }
}
allowAutoDownloads();
chrome.runtime.onInstalled.addListener(() => { allowAutoDownloads(); });

// Batch state lives in storage.local (content scripts can't use the session
// area); clear leftovers on browser start so an interrupted batch never
// resumes unexpectedly.
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.remove(BATCH_KEY).catch(() => {});
});

// ---------------------------------------------------------------- 下载中转

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
      justification: '将下载完成的视频数据封装为 Blob URL，交给 chrome.downloads 保存到剧集子目录',
    }).catch((e) => {
      if (!/single offscreen|Only a single/.test(String(e?.message || e))) throw e;
    }).finally(() => { ensureChain = null; });
  }
  await ensureChain;
}

// saveId -> { filename, tabId, url }
const activeSaves = new Map();

function onDownloadChanged(listener) {
  chrome.downloads.onChanged.addListener(listener);
}

async function onOSUrl(msg) {
  const meta = activeSaves.get(msg.saveId);
  if (!meta) return;
  meta.url = msg.url;
  try {
    const conflictAction = meta.conflictAction === 'overwrite' ? 'overwrite' : 'uniquify';
    const downloadId = await chrome.downloads.download({
      url: msg.url,
      filename: meta.filename,
      saveAs: false,
      conflictAction,
    });
    const listener = (delta) => {
      if (delta.id !== downloadId) return;
      const st = delta.state;
      if (!st || (st.current !== 'complete' && st.current !== 'interrupted')) return;
      chrome.downloads.onChanged.removeListener(listener);
      chrome.runtime.sendMessage({ type: 'os-revoke', saveId: msg.saveId, url: msg.url }).catch(() => {});
      const ok = st.current === 'complete';
      chrome.tabs.sendMessage(meta.tabId, {
        type: 'dl-settled',
        saveId: msg.saveId,
        ok,
        error: ok ? '' : (delta.error?.current || 'download interrupted'),
      }).catch(() => {});
      activeSaves.delete(msg.saveId);
    };
    onDownloadChanged(listener);
  } catch (e) {
    chrome.runtime.sendMessage({ type: 'os-revoke', saveId: msg.saveId, url: msg.url }).catch(() => {});
    chrome.tabs.sendMessage(meta.tabId, {
      type: 'dl-settled', saveId: msg.saveId, ok: false, error: String(e?.message || e),
    }).catch(() => {});
    activeSaves.delete(msg.saveId);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'os-url') {
    onOSUrl(message);
    return false;
  }

  if (message.type === 'rv-save-begin' && sender.tab) {
    activeSaves.set(message.saveId, {
      filename: message.filename,
      tabId: sender.tab.id,
      url: null,
      conflictAction: message.conflictAction,
    });
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ type: 'os-save-begin', saveId: message.saveId, mime: message.mime }))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true; // 分块必须严格有序：逐条 ACK
  }
  if (message.type === 'rv-save-chunk') {
    chrome.runtime.sendMessage({ type: 'os-save-chunk', saveId: message.saveId, b64: message.b64 })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (message.type === 'rv-save-end') {
    chrome.runtime.sendMessage({ type: 'os-save-end', saveId: message.saveId })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  return false;
});
