// Offscreen document：接收内容脚本（经 service worker 中转）传来的视频数据块，
// 组装成 Blob 并生成扩展源 的 objectURL，交给 service worker 调
// chrome.downloads 保存（downloads API 的 filename 支持子目录）。

const saves = new Map();

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'os-save-begin') {
    saves.set(msg.saveId, { chunks: [], mime: msg.mime || 'video/mp4' });
  } else if (msg.type === 'os-save-chunk') {
    const s = saves.get(msg.saveId);
    if (!s) return;
    const bin = atob(msg.b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    s.chunks.push(u8);
  } else if (msg.type === 'os-save-end') {
    const s = saves.get(msg.saveId);
    if (!s) return;
    const blob = new Blob(s.chunks, { type: s.mime });
    const url = URL.createObjectURL(blob);
    chrome.runtime.sendMessage({ type: 'os-url', saveId: msg.saveId, url, size: blob.size })
      .catch(() => {});
  } else if (msg.type === 'os-revoke') {
    const s = saves.get(msg.saveId);
    if (!s) return;
    try { URL.revokeObjectURL(msg.url); } catch {}
    saves.delete(msg.saveId);
  }
});
