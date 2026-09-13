// 扩展保存管线：内容脚本 →(分块 base64)→ offscreen 直接 ACK（SW 不在数据路径上，
// 仅在 begin 时记账并确保 offscreen 存在）→ 组装 → chrome.downloads / 文件句柄写入。
// 大文件优化：16MB 分块减少往返；FileReader 原生 base64（比 JS 循环快 ~2x）。

async function toBase64(u8) {
  const blob = new Blob([u8]);
  const url = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('FileReader 失败'));
    fr.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(',') + 1);
}

export function saveViaExtension(chunks, filename, mime, { conflictAction = 'uniquify' } = {}) {
  const saveId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const CHUNK = 16 * 1024 * 1024;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok, error, note, finalFilename) => {
      if (settled) return;
      settled = true;
      chrome.runtime.onMessage.removeListener(onMsg);
      clearTimeout(timer);
      resolve({ ok, error: error || '', note: note || '', filename: finalFilename || filename });
    };
    const onMsg = (msg) => {
      if (msg?.type === 'dl-settled' && msg.saveId === saveId) finish(!!msg.ok, msg.error, msg.note, msg.finalFilename);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    const timer = setTimeout(() => finish(false, '保存超时'), 20 * 60 * 1000);
    (async () => {
      try {
        await chrome.runtime.sendMessage({ type: 'rv-save-begin', saveId, filename, mime, conflictAction });
        for (const piece of chunks) {
          for (let off = 0; off < piece.length; off += CHUNK) {
            const b64 = await toBase64(piece.subarray(off, off + CHUNK));
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
