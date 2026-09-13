// 扩展保存管线：内容脚本 →(分块 base64)→ offscreen 直接 ACK（SW 不在数据路径上，
// 仅在 begin 时记账并确保 offscreen 存在）→ 组装 → chrome.downloads / 文件句柄写入。
// 大文件优化：16MB 分块减少往返；FileReader 原生 base64（比 JS 循环快 ~2x）。

/**
 * @typedef {Object} SaveProgress
 * @property {number} sent
 * @property {number} total
 * @property {number} pct
 */

/**
 * @typedef {Object} SaveOptions
 * @property {'uniquify' | 'overwrite' | 'prompt'} [conflictAction]
 * @property {(p: SaveProgress) => void} [onProgress]
 */

/**
 * @typedef {Object} SaveResult
 * @property {boolean} ok
 * @property {string} error
 * @property {string} note
 * @property {string} filename
 * @property {boolean} cancelled
 */

// 当前进行中的保存：让 99% 之后的"取消"按钮仍然有效（释放内存、立即复位 UI）
/** @type {{ saveId: string, cancel: () => void } | null} */
let activeSave = null;

/** @returns {void} */
export function cancelActiveSave() {
  activeSave?.cancel();
}

/**
 * @param {Uint8Array} u8
 * @returns {Promise<string>}
 */
async function toBase64(u8) {
  const blob = new Blob([/** @type {BlobPart} */ (u8)]);
  const url = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(/** @type {string} */ (fr.result));
    fr.onerror = () => reject(fr.error || new Error('FileReader 失败'));
    fr.readAsDataURL(blob);
  });
  return url.slice(url.indexOf(',') + 1);
}

/**
 * 经扩展管线保存文件（offscreen 组装 → chrome.downloads 或自定义目录句柄写入）。
 * @param {Uint8Array[]} chunks
 * @param {string} filename 可含子目录（剧集归目录依赖此能力）
 * @param {string} mime
 * @param {SaveOptions} [opts]
 * @returns {Promise<SaveResult>}
 */
export function saveViaExtension(chunks, filename, mime, { conflictAction = 'uniquify', onProgress } = {}) {
  const saveId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const CHUNK = 16 * 1024 * 1024;
  const totalToSend = chunks.reduce((s, p) => s + p.length, 0);
  return new Promise((resolve) => {
    let settled = false;
    /**
     * @param {boolean} ok
     * @param {string} [error]
     * @param {string} [note]
     * @param {string | null} [finalFilename]
     * @param {boolean} [cancelled]
     */
    const finish = (ok, error, note, finalFilename, cancelled = false) => {
      if (settled) return;
      settled = true;
      if (activeSave?.saveId === saveId) activeSave = null;
      chrome.runtime.onMessage.removeListener(onMsg);
      clearTimeout(timer);
      resolve({ ok, error: error || '', note: note || '', filename: finalFilename || filename, cancelled });
    };
    /** @param {any} msg */
    const onMsg = (msg) => {
      if (msg?.type === 'dl-settled' && msg.saveId === saveId) finish(!!msg.ok, msg.error, msg.note, msg.finalFilename);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    const timer = setTimeout(() => finish(false, '保存超时'), 20 * 60 * 1000);
    activeSave = {
      saveId,
      cancel: () => {
        // offscreen 丢弃该 saveId 的 chunks（释放内存）；随后进行中的 chunk ACK
        // 会返回 ok:false 使发送循环立即抛出，finish 幂等不会二次 resolve
        chrome.runtime.sendMessage({ to: 'os', type: 'os-abort', saveId }).catch(() => {});
        finish(false, '已取消', '', null, true);
      },
    };
    (async () => {
      try {
        // 每个环节都校验 ACK：offscreen 死亡/重启时 sendMessage 会静默 resolve
        // undefined 或得到错误应答，必须在第一时间抛错走回退，而不是挂到超时
        const begin = await chrome.runtime.sendMessage({ type: 'rv-save-begin', saveId, filename, mime, conflictAction });
        if (!begin || begin.ok === false) throw new Error(begin?.error || '保存通道不可用');
        let sent = 0;
        for (const piece of chunks) {
          for (let off = 0; off < piece.length; off += CHUNK) {
            const end = Math.min(off + CHUNK, piece.length);
            const b64 = await toBase64(piece.subarray(off, end));
            const ack = await chrome.runtime.sendMessage({ type: 'rv-save-chunk', saveId, b64 });
            if (!ack || ack.ok === false) throw new Error(ack?.error || '保存通道中断');
            sent += end - off;
            onProgress?.({ sent, total: totalToSend, pct: totalToSend ? (sent / totalToSend) * 100 : 0 });
          }
        }
        const fin = await chrome.runtime.sendMessage({ type: 'rv-save-end', saveId });
        if (!fin || fin.ok === false) throw new Error(fin?.error || '保存收尾失败');
      } catch (e) {
        finish(false, String(/** @type {any} */ (e)?.message || e));
      }
    })();
  });
}
