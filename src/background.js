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
  meta.note = msg.note || '';
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
      chrome.runtime.sendMessage({ to: 'os', type: 'os-revoke', saveId: msg.saveId, url: msg.url }).catch(() => {});
      const ok = st.current === 'complete';
      if (ok) ledgerPut(meta.filename.split(/[\\/]/).pop(), downloadId);
      chrome.tabs.sendMessage(meta.tabId, {
        type: 'dl-settled',
        saveId: msg.saveId,
        ok,
        error: ok ? '' : (delta.error?.current || 'download interrupted'),
        note: meta.note || '',
      }).catch(() => {});
      activeSaves.delete(msg.saveId);
    };
    onDownloadChanged(listener);
  } catch (e) {
    chrome.runtime.sendMessage({ to: 'os', type: 'os-revoke', saveId: msg.saveId, url: msg.url }).catch(() => {});
    chrome.tabs.sendMessage(meta.tabId, {
      type: 'dl-settled', saveId: msg.saveId, ok: false, error: String(e?.message || e),
    }).catch(() => {});
    activeSaves.delete(msg.saveId);
  }
}

// ---------------------------------------------------------------- 已下载判断

// 判定优先级：
//   1) 账本（basename → downloadId，扩展自己保存的记录，O(1) 命中）
//   2) 下载历史精确搜索（覆盖账本之前的下载）
//   3) 磁盘探测（权威兜底）：向目标路径下 0 字节占位，uniquify 改名 → 已存在；
//      原名落盘 → 不存在，随即删除占位并抹除历史。不依赖任何历史记录。
const LEDGER_KEY = 'rv-hud:dl-ledger';

async function ledgerGet() {
  try {
    const raw = await chrome.storage.local.get(LEDGER_KEY);
    return raw[LEDGER_KEY] || {};
  } catch {
    return {};
  }
}

async function ledgerPut(basename, id) {
  try {
    const ledger = await ledgerGet();
    ledger[basename] = { id, at: Date.now() };
    await chrome.storage.local.set({ [LEDGER_KEY]: ledger });
  } catch {}
}

async function historyExists(basename) {
  const rec = (await ledgerGet())[basename];
  if (rec) {
    try {
      const [item] = await chrome.downloads.search({ id: rec.id });
      if (item && item.state === 'complete' && item.exists !== false) return true;
    } catch {}
  }
  try {
    const items = await chrome.downloads.search({ query: [basename], limit: 200 });
    const hit = items.find((d) => d.state === 'complete' && d.exists !== false && (d.filename || '').endsWith(basename));
    if (hit) {
      ledgerPut(basename, hit.id);
      return true;
    }
  } catch {}
  return false;
}

function waitComplete(downloadId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      chrome.downloads.onChanged.removeListener(listener);
      try { const [it] = await chrome.downloads.search({ id: downloadId }); resolve(it || null); } catch { resolve(null); }
    }, timeoutMs);
    const listener = async (delta) => {
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

async function probeOne(filename) {
  const base = filename.split('/').pop();
  let id;
  try {
    id = await chrome.downloads.download({
      url: 'data:application/octet-stream,',
      filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
  } catch {
    return false; // 探测通道不可用，按不存在处理（走正常下载）
  }
  const item = await waitComplete(id);
  try { await chrome.downloads.removeFile(id); } catch {}
  try { await chrome.downloads.erase({ id }); } catch {}
  if (!item || !item.filename) return false;
  // Chrome 仅在目标名被占用时才改名（name (1).ext），落点名 ≠ 目标名 → 已存在
  return item.filename.split(/[\\/]/).pop() !== base;
}

async function probeExists(filename) {
  // 先探测根目录同名（兼容 1.3.0 之前的平铺文件，且不产生目录副作用）
  const base = filename.split('/').pop();
  if (!filename.includes('/')) return probeOne(base);
  if (await probeOne(base)) return true;
  return probeOne(filename);
}

async function fileExists(filename) {
  // 自定义目录模式：经 offscreen 直接查磁盘句柄（不依赖任何下载历史）
  try {
    const flag = (await chrome.storage.local.get('rv-hud:fsdir'))['rv-hud:fsdir'];
    if (flag?.name) {
      await ensureOffscreen();
      const r = await chrome.runtime.sendMessage({ to: 'os', type: 'os-file-exists', filename });
      if (r?.handled) return { exists: !!r.exists, via: 'fs' };
    }
  } catch {}
  const basename = filename.split('/').pop();
  if (await historyExists(basename)) return { exists: true, via: 'history' };
  if (await probeExists(filename)) return { exists: true, via: 'probe' };
  return { exists: false };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'os-url') {
    onOSUrl(message);
    return false;
  }

  if (message.type === 'os-saved') {
    const meta = activeSaves.get(message.saveId);
    if (meta) {
      chrome.tabs.sendMessage(meta.tabId, {
        type: 'dl-settled',
        saveId: message.saveId,
        ok: !!message.ok,
        error: message.ok ? '' : (message.error || 'save failed'),
        note: message.note || '',
      }).catch(() => {});
      activeSaves.delete(message.saveId);
    }
    return false;
  }

  if (message.type === 'rv-file-exists') {
    fileExists(String(message.filename || String(message.basename || '')))
      .then((r) => sendResponse(r))
      .catch(() => sendResponse({ exists: false, via: 'error' }));
    return true;
  }

  if (message.type === 'rv-save-begin' && sender.tab) {
    activeSaves.set(message.saveId, {
      filename: message.filename,
      tabId: sender.tab.id,
      url: null,
      conflictAction: message.conflictAction,
    });
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({ to: 'os', type: 'os-save-begin', saveId: message.saveId, filename: message.filename, mime: message.mime }))
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true; // 分块必须严格有序：逐条 ACK
  }
  if (message.type === 'rv-save-chunk') {
    chrome.runtime.sendMessage({ to: 'os', type: 'os-save-chunk', saveId: message.saveId, b64: message.b64 })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (message.type === 'rv-save-end') {
    chrome.runtime.sendMessage({ to: 'os', type: 'os-save-end', saveId: message.saveId })
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  return false;
});
