// Offscreen document：保存会话的消息管线（逻辑全在 net/save-session.js）。
// 自定义目录句柄存 IDB（面板挑选/授权）；无句柄即 NOHANDLE，权限失效即 REAUTH
// （不信任 queryPermission——对 IDB 回读句柄会虚报，写入抛 NotAllowedError 才算数）。
// 数据链路：begin 经 SW 转发（确保本文档存在）；chunk/end 由内容脚本广播、本文档直接 ACK。

import { loadDirHandle } from './net/fsdir.js';
import { SaveSession } from './net/save-session.js';
import { FsStreamWriter, fsFileExists } from './net/fswriter.js';

/** @type {Map<string, SaveSession>} saveId -> 保存会话 */
const sessions = new Map();

/**
 * FS 错误映射：权限类 → REAUTH。
 * @param {any} e
 * @returns {{ ok: false, code?: string, error: string }}
 */
function mapErr(e) {
  const name = e?.name || '';
  const error = String(e?.message || e);
  if (/NotAllowed|Security/.test(name)) return { ok: false, code: 'REAUTH', error };
  return { ok: false, error };
}

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
 * @param {any} msg
 * @returns {Promise<any>}
 */
async function handle(msg) {
  if (msg.type === 'os-save-begin') {
    const root = await loadDirHandle();
    if (!root) return { ok: false, code: 'NOHANDLE', error: '未选择下载目录' };
    try {
      const b = await SaveSession.begin(root, String(msg.filename || ''), {
        fingerprint: String(msg.fingerprint || ''),
        segTotal: Number(msg.segTotal) || 0,
      });
      if (b.done) return { ok: true, done: true };
      sessions.set(msg.saveId, b.session);
      return { ok: true, resumeFrom: b.resumeFrom };
    } catch (e) {
      return mapErr(e);
    }
  }
  if (msg.type === 'rv-save-chunk') {
    const s = sessions.get(msg.saveId);
    if (!s) return { ok: false, error: 'unknown save' };
    try {
      await s.pushSegment(fromBase64(String(msg.b64 || '')));
      return { ok: true };
    } catch (e) {
      return mapErr(e);
    }
  }
  if (msg.type === 'rv-save-end' || msg.type === 'os-save-end') {
    const s = sessions.get(msg.saveId);
    if (!s) return { ok: false, error: 'unknown save' };
    sessions.delete(msg.saveId);
    try {
      const fin = await s.finalize();
      return { ok: true, finalName: fin.finalName, note: fin.note };
    } catch (e) {
      return mapErr(e);
    }
  }
  if (msg.type === 'os-abort') {
    // 中止：保留 .part+sidecar（断点续传凭据）
    const s = sessions.get(msg.saveId);
    sessions.delete(msg.saveId);
    if (s) await s.abort().catch(() => {});
    return { ok: true };
  }
  if (msg.type === 'os-file-exists') {
    // dedup 直查：最终名 .mp4/.ts 双查（透传产物也算已下载）
    const root = await loadDirHandle();
    if (!root) return { handled: false, code: 'NOHANDLE' };
    const stem = String(msg.filename || '').replace(/\.mp4$/i, '');
    try {
      const exists = await fsFileExists(root, `${stem}.mp4`) || await fsFileExists(root, `${stem}.ts`);
      return { handled: true, exists };
    } catch (e) {
      return { handled: false, ...mapErr(e) };
    }
  }
  if (msg.type === 'os-write-file') {
    // 小文件直写（封面）：整文件一次落盘（覆盖写）
    const root = await loadDirHandle();
    if (!root) return { ok: false, code: 'NOHANDLE', error: '未选择下载目录' };
    try {
      const w = await FsStreamWriter.create(root, String(msg.filename || ''));
      await w.write(fromBase64(String(msg.b64 || '')));
      await w.close();
      return { ok: true };
    } catch (e) {
      return mapErr(e);
    }
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
    .catch((e) => sendResponse({ ok: false, error: String(/** @type {any} */ (e)?.message || e) }));
  return true;
});
