// Offscreen document：保存会话的消息管线（逻辑全在 net/save-session.js）。
// 落盘链路：OPFS 流式暂存（免授权）→ 完成文件 objectURL → SW chrome.downloads
// 落到浏览器下载目录。数据链路：begin 经 SW 转发（确保本文档存在）；
// chunk/end 由内容脚本广播、本文档直接 ACK。

import { SaveSession } from './net/save-session.js';

/** @type {Map<string, SaveSession>} saveId -> 保存会话 */
const sessions = new Map();

// OPFS 为磁盘级存储，请求持久化免回收（尽力而为）
navigator.storage?.persist?.().catch(() => {});

/**
 * @param {string} b64
 * @returns {Uint8Array}
 */
function fromBase64(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/**
 * OPFS 完成文件的落盘钩子：objectURL → SW os-url → chrome.downloads → 回执。
 * @param {string} filename
 * @param {Blob} file
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
async function finalizeViaDownloads(filename, file) {
  const url = URL.createObjectURL(file);
  try {
    const r = await chrome.runtime.sendMessage({ to: 'sw', type: 'os-url', url, filename });
    if (!r || r.ok === false) return { ok: false, error: r?.error || '落盘失败' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((/** @type {any} */ (e))?.message || e) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * @param {any} msg
 * @returns {Promise<any>}
 */
async function handle(msg) {
  if (msg.type === 'os-save-begin') {
    const b = await SaveSession.begin(String(msg.filename || ''), {
      fingerprint: String(msg.fingerprint || ''),
      segTotal: Number(msg.segTotal) || 0,
    }, { finalizeViaDownloads });
    sessions.set(msg.saveId, b.session);
    return { ok: true, resumeFrom: b.resumeFrom };
  }
  if (msg.type === 'rv-save-chunk') {
    const s = sessions.get(msg.saveId);
    if (!s) return { ok: false, error: 'unknown save' };
    await s.pushSegment(fromBase64(String(msg.b64 || '')));
    return { ok: true };
  }
  if (msg.type === 'rv-save-end' || msg.type === 'os-save-end') {
    const s = sessions.get(msg.saveId);
    if (!s) return { ok: false, error: 'unknown save' };
    sessions.delete(msg.saveId);
    const fin = await s.finalize();
    return { ok: true, finalName: fin.finalName, note: fin.note };
  }
  if (msg.type === 'os-abort') {
    // 中止：保留 .part+sidecar（断点续传凭据）
    const s = sessions.get(msg.saveId);
    sessions.delete(msg.saveId);
    if (s) await s.abort().catch(() => {});
    return { ok: true };
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 严格寻址：控制消息只认 to:'os'；
  // 数据消息 rv-save-chunk/end 为内容脚本广播，由本文档直接 ACK（保证分块顺序）
  if (!msg || typeof msg !== 'object') return false;
  const isOs = msg.to === 'os';
  const isDirectData = msg.type === 'rv-save-chunk' || msg.type === 'rv-save-end';
  if (!isOs && !isDirectData) return false;
  handle(msg)
    .then((r) => sendResponse(r || { ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String((/** @type {any} */ (e))?.message || e) }));
  return true;
});
