// Stateless service worker: owns side-panel opening.
// Toolbar icon click opens the side panel automatically.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

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
