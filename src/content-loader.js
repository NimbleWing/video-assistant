// Content script entry (isolated world). MV3 manifest content scripts cannot be
// ES modules directly, so this thin loader bootstraps the real module graph.
(async () => {
  try {
    await import(chrome.runtime.getURL('src/main.js'));
  } catch (e) {
    console.error('[RouVideo] 模块加载失败', e);
  }
})();
