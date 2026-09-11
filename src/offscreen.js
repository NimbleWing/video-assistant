// Offscreen document：两种保存模式。
//  A. 自定义目录模式（IDB 中存有目录句柄）：直接经文件句柄写入，剧集子目录自动创建，
//     覆盖写；已下载判断变为真实磁盘直查。
//  B. 默认目录模式：组装 Blob 生成 objectURL，交给 service worker 调 chrome.downloads。
// 权限策略：不信任 queryPermission（对 IDB 回读句柄会虚报 prompt），统一"乐观尝试"：
// 写入/读取抛 NotAllowedError 时才视为本会话无权限，回退默认目录并附带提示。
// 数据链路：内容脚本 →(to:'sw' 分块)→ SW →(to:'os' 转发)→ 本文档。
import { loadDirHandle } from './net/fsdir.js';

const saves = new Map();

// 解析 filename（形如 剧名/集名.mp4）到文件句柄。
// 错误分类：NotFoundError=目标不存在；NotAllowedError/SecurityError=本会话无权限。
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
  if (!s) return;
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  s.chunks.push(u8);
}

function fallbackBlob(s, saveId, note) {
  const blob = new Blob(s.chunks, { type: s.mime });
  const url = URL.createObjectURL(blob);
  chrome.runtime.sendMessage({ to: 'sw', type: 'os-url', saveId, url, size: blob.size, note: note || '' }).catch(() => {});
}

async function handleOsMessage(msg) {
  if (msg.type === 'os-save-begin') {
    const root = await loadDirHandle();
    saves.set(msg.saveId, { chunks: [], mime: msg.mime || 'video/mp4', hasHandle: !!root, filename: msg.filename });
    return { ok: true };
  }
  if (msg.type === 'os-save-chunk') {
    pushChunk(msg.saveId, msg.b64);
    return { ok: true };
  }
  if (msg.type === 'os-save-end') {
    const s = saves.get(msg.saveId);
    if (!s) return { ok: false, error: 'no such save' };
    saves.delete(msg.saveId);
    if (s.hasHandle) {
      const r = await resolveFileHandle(s.filename, true);
      if (r.handle) {
        try {
          const w = await r.handle.createWritable();
          await w.write(new Blob(s.chunks, { type: s.mime }));
          await w.close();
          chrome.runtime.sendMessage({ to: 'sw', type: 'os-saved', saveId: msg.saveId, ok: true }).catch(() => {});
          return { ok: true };
        } catch (e) {
          const note = /NotAllowed|Security/.test(e?.name || '')
            ? '下载目录未授权，本次已保存到默认下载目录'
            : `写入自定义目录失败（${e?.message || e}），已保存到默认下载目录`;
          fallbackBlob(s, msg.saveId, note);
          return { ok: true, fallback: true };
        }
      }
      if (r.err === 'NOHANDLE') {
        fallbackBlob(s, msg.saveId, '');
        return { ok: true, fallback: true };
      }
      // 解析阶段就无权限（目录句柄不可访问）
      const note = /NotAllowed|Security/.test(r.err)
        ? '下载目录未授权，本次已保存到默认下载目录'
        : `写入自定义目录失败（${r.err}），已保存到默认下载目录`;
      fallbackBlob(s, msg.saveId, note);
      return { ok: true, fallback: true };
    }
    fallbackBlob(s, msg.saveId, '');
    return { ok: true };
  }
  if (msg.type === 'os-revoke') {
    try { URL.revokeObjectURL(msg.url); } catch {}
    return { ok: true };
  }
  if (msg.type === 'os-file-exists') {
    const r = await resolveFileHandle(msg.filename, false);
    if (r.handle) return { handled: true, exists: true };
    if (r.err === 'NotFoundError') return { handled: true, exists: false };
    // 无句柄 / 无权限 / 其它错误：交给默认目录的判断逻辑
    return { handled: false };
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 严格寻址：只响应 to:'os'，避免对内容脚本的 to:'sw' 广播误发 ACK 破坏分块顺序
  if (!msg || typeof msg !== 'object' || msg.to !== 'os') return false;
  handleOsMessage(msg)
    .then((r) => sendResponse(r || { ok: true }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true;
});
