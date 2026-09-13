// Offscreen document：两种保存模式。
//  A. 自定义目录模式（IDB 中存有目录句柄）：直接经文件句柄写入，剧集子目录自动创建，
//     覆盖写；已下载判断变为真实磁盘直查。
//  B. 默认目录模式：组装 Blob 生成 objectURL，交给 service worker 调 chrome.downloads。
// 权限策略：不信任 queryPermission（对 IDB 回读句柄会虚报 prompt），统一"乐观尝试"：
// 写入/读取抛 NotAllowedError 时才视为本会话无权限，回退默认目录并附带提示。
// 数据链路（大文件优化：SW 不在中转路径上）：
//   begin（记账经 SW 转发，to:'os'）；chunk/end 由内容脚本广播、本文档直接 ACK。
import { loadDirHandle } from './net/fsdir.js';

const saves = new Map();

async function resolveFileHandle(filename, create) {
  const root = await loadDirHandle();
  if (!root) return { err: 'NOHANDLE' };
  try {
    const segs = filename.split('/').filter(Boolean);
    const base = segs.pop();
    let dir = root;
    for (const s of segs) dir = await dir.getDirectoryHandle(s, { create: !!create });
    return { handle: await dir.getFileHandle(base, { create: !!create }) };
  } catch (e) {
    return { err: e?.name || 'ERROR' };
  }
}

function pushChunk(saveId, b64) {
  const s = saves.get(saveId);
  if (!s) return false; // 未知 saveId（offscreen 重启丢 Map）必须报错，让内容脚本立刻回退
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  s.chunks.push(u8);
  return true;
}

function fallbackBlob(s, saveId, note) {
  const blob = new Blob(s.chunks, { type: s.mime });
  const url = URL.createObjectURL(blob);
  s.chunks = [];
  chrome.runtime.sendMessage({ to: 'sw', type: 'os-url', saveId, url, size: blob.size, note: note || '' }).catch(() => {});
}

async function finalizeSave(saveId) {
  const s = saves.get(saveId);
  if (!s) return { ok: false, error: 'no such save' };
  saves.delete(saveId);
  if (s.hasHandle) {
    const r = await resolveFileHandle(s.filename, true);
    if (r.handle) {
      try {
        const w = await r.handle.createWritable();
        await w.write(new Blob(s.chunks, { type: s.mime }));
        await w.close();
        s.chunks = [];
        chrome.runtime.sendMessage({ to: 'sw', type: 'os-saved', saveId, ok: true }).catch(() => {});
        return { ok: true };
      } catch (e) {
        const note = /NotAllowed|Security/.test(e?.name || '')
          ? '下载目录未授权，本次已保存到默认下载目录'
          : `写入自定义目录失败（${e?.message || e}），已保存到默认下载目录`;
        fallbackBlob(s, saveId, note);
        return { ok: true, fallback: true };
      }
    }
    if (r.err === 'NOHANDLE') {
      fallbackBlob(s, saveId, '');
      return { ok: true, fallback: true };
    }
    const note = /NotAllowed|Security/.test(r.err)
      ? '下载目录未授权，本次已保存到默认下载目录'
      : `写入自定义目录失败（${r.err}），已保存到默认下载目录`;
    fallbackBlob(s, saveId, note);
    return { ok: true, fallback: true };
  }
  fallbackBlob(s, saveId, '');
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 严格寻址：控制消息只认 to:'os'；
  // 数据消息 rv-save-chunk/end 为内容脚本广播，由本文档直接 ACK（保证分块顺序）
  if (!msg || typeof msg !== 'object') return false;
  const isOs = msg.to === 'os';
  const isDirectData = msg.type === 'rv-save-chunk' || msg.type === 'rv-save-end';
  if (!isOs && !isDirectData) return false;

  (async () => {
    if (msg.type === 'os-save-begin') {
      const root = await loadDirHandle();
      saves.set(msg.saveId, { chunks: [], mime: msg.mime || 'video/mp4', hasHandle: !!root, filename: msg.filename });
      return { ok: true };
    }
    if (msg.type === 'rv-save-chunk') {
      return pushChunk(msg.saveId, msg.b64) ? { ok: true } : { ok: false, error: 'unknown save' };
    }
    if (msg.type === 'rv-save-end' || msg.type === 'os-save-end') {
      return await finalizeSave(msg.saveId);
    }
    if (msg.type === 'os-revoke') {
      try { URL.revokeObjectURL(msg.url); } catch {}
      return { ok: true };
    }
    if (msg.type === 'os-abort') {
      // 用户取消保存：丢弃 chunks 释放内存（内容脚本下一包会得到 ok:false 并停止）
      const s = saves.get(msg.saveId);
      if (s) { s.chunks = []; saves.delete(msg.saveId); }
      return { ok: true };
    }
    if (msg.type === 'os-file-exists') {
      const r = await resolveFileHandle(msg.filename, false);
      if (r.handle) return { handled: true, exists: true };
      if (r.err === 'NotFoundError') return { handled: true, exists: false };
      return { handled: false };
    }
    return { ok: true };
  })()
    .then((r) => sendResponse(r || { ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
