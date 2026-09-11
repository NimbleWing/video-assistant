// 扩展保存管线：内容脚本 →(分块 base64, SW 逐条 ACK 保序)→ offscreen 组装 Blob
// → chrome.downloads（filename 支持子目录；conflictAction 可选 uniquify/overwrite）。

function bytesToBase64(u8) {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < u8.length; i += step) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + step));
  }
  return btoa(s);
}

export function saveViaExtension(chunks, filename, mime, { conflictAction = 'uniquify' } = {}) {
  const saveId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const CHUNK = 4 * 1024 * 1024;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok, error, note) => {
      if (settled) return;
      settled = true;
      chrome.runtime.onMessage.removeListener(onMsg);
      clearTimeout(timer);
      resolve({ ok, error: error || '', note: note || '' });
    };
    const onMsg = (msg) => {
      if (msg?.type === 'dl-settled' && msg.saveId === saveId) finish(!!msg.ok, msg.error, msg.note);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    const timer = setTimeout(() => finish(false, '保存超时'), 10 * 60 * 1000);
    (async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'rv-save-begin', saveId, filename, mime, conflictAction });
        for (const piece of chunks) {
          for (let off = 0; off < piece.length; off += CHUNK) {
            const b64 = bytesToBase64(piece.subarray(off, off + CHUNK));
            await chrome.runtime.sendMessage({ type: 'rv-save-chunk', saveId, b64 });
          }
        }
        await chrome.runtime.sendMessage({ type: 'rv-save-end', saveId });
      } catch (e) {
        finish(false, String(e?.message || e));
      }
    })();
  });
}
