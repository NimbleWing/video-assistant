// Stateless service worker: owns side-panel opening.
// Toolbar icon click opens the side panel automatically.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Batch downloads save one file per video without user gestures; allow
// automatic multiple downloads on rou.video so Chrome doesn't silently block
// them. Idempotent — safe to run on every worker boot.
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
  chrome.storage.local.remove('rv-hud:batch').catch(() => {});
});

// FAB click / Alt+D in the page ask us to open the side panel. The
// sidePanel.open() call must happen synchronously inside this listener —
// the user gesture is lost after the first await.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'rv-open-panel' || !sender.tab) return false;
  chrome.sidePanel.open({ windowId: sender.tab.windowId })
    .then(() => sendResponse({ ok: true }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});
