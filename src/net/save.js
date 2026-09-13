// 流式保存通道：内容脚本 → offscreen（begin 经 SW 确保 offscreen + 转发；
// chunk/end 由 offscreen 直接 ACK，SW 不在数据路径上）。
// 落盘 = OPFS 流式暂存 → 完成后 chrome.downloads（浏览器下载目录，免授权）。
// 分段直发（>16MB 内部切片），ACK 即背压：offscreen 死亡/重启时 sendMessage
// 静默 resolve undefined 或得到错误应答，第一时间抛错而不是挂到超时。
// 取消/失败均保留 .part+sidecar（断点续传凭据），重试自动续传。

/**
 * @typedef {Object} SaveBegin
 * @property {boolean} ok
 * @property {string} [code]
 * @property {string} [error]
 * @property {number} [resumeFrom]
 * @property {SaveWriter} [session]
 */

/**
 * @typedef {Object} SaveWriter
 * @property {(u8: Uint8Array) => Promise<void>} write 发送一个分段（ACK 背压）
 * @property {() => Promise<{ ok: boolean, finalName: string, note: string, backend?: string, code?: string, error?: string }>} finalize
 * @property {() => Promise<void>} abort 中止（offscreen 保留 .part+sidecar）
 */

/** 当前进行中的保存：让"取消"按钮在保存阶段仍然有效 */
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
 * @param {string} message
 * @param {string} [code]
 * @returns {Error & { code?: string }}
 */
function codedError(message, code) {
  const e = /** @type {Error & { code?: string }} */ (new Error(message));
  if (code) e.code = code;
  return e;
}

const CHUNK = 16 * 1024 * 1024;

/**
 * 打开保存会话。
 * @param {{ filename: string, fingerprint: string, segTotal: number }} p
 * @returns {Promise<SaveBegin>}
 */
export async function openSaveSession({ filename, fingerprint, segTotal }) {
  const saveId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let cancelled = false;
  let aborted = false;
  /** @returns {Error} */
  const abortErr = () => new DOMException('aborted', 'AbortError');

  const begin = await chrome.runtime.sendMessage({
    type: 'rv-save-begin', saveId, filename, fingerprint, segTotal,
  }).catch((e) => ({ ok: false, error: String(/** @type {any} */ (e)?.message || e) }));
  if (!begin || begin.ok === false) {
    return { ok: false, code: begin?.code, error: begin?.error || '保存通道不可用' };
  }

  const session = {
    /**
     * @param {Uint8Array} u8
     * @returns {Promise<void>}
     */
    async write(u8) {
      if (cancelled) throw abortErr();
      for (let off = 0; off < u8.length; off += CHUNK) {
        const end = Math.min(off + CHUNK, u8.length);
        const b64 = await toBase64(u8.subarray(off, end));
        const ack = await chrome.runtime.sendMessage({ type: 'rv-save-chunk', saveId, b64 })
          .catch((e) => ({ ok: false, error: String(/** @type {any} */ (e)?.message || e) }));
        if (cancelled) throw abortErr();
        if (!ack || ack.ok === false) throw codedError(ack?.error || '保存通道中断', ack?.code);
      }
    },
    /** @returns {Promise<{ ok: boolean, finalName: string, note: string, code?: string, error?: string }>} */
    async finalize() {
      if (cancelled) throw abortErr();
      const fin = await chrome.runtime.sendMessage({ type: 'rv-save-end', saveId })
        .catch((e) => ({ ok: false, error: String((/** @type {any} */ (e))?.message || e) }));
      if (cancelled) throw abortErr();
      if (!fin || fin.ok === false) return { ok: false, finalName: filename, note: '', code: fin?.code, error: fin?.error || '保存收尾失败' };
      return { ok: true, finalName: fin.finalName || filename, note: fin.note || '' };
    },
    /** @returns {Promise<void>} */
    async abort() {
      if (aborted) return;
      aborted = true;
      await chrome.runtime.sendMessage({ to: 'os', type: 'os-abort', saveId }).catch(() => {});
    },
  };

  activeSave = {
    saveId,
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      // offscreen 落盘 sidecar 并关闭 .part（续传凭据）；进行中的 write 下一拍抛 AbortError
      session.abort();
    },
  };
  return { ok: true, resumeFrom: begin.resumeFrom || 0, session };
}

/**
 * 小文件直写（封面等）：经 SW 确保 offscreen 后转发，整文件一条消息。
 * @param {Uint8Array} u8
 * @param {string} filename 可含子目录
 * @returns {Promise<{ ok: boolean, error?: string, code?: string }>}
 */
export async function saveSmallFile(u8, filename) {
  const b64 = await toBase64(u8);
  const r = await chrome.runtime.sendMessage({ type: 'rv-save-cover', filename, b64 })
    .catch((e) => ({ ok: false, error: String(/** @type {any} */ (e)?.message || e) }));
  if (!r || r.ok === false) return { ok: false, error: r?.error || '保存失败', code: r?.code };
  return { ok: true };
}
