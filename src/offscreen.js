// Offscreen document：两种保存模式。
//  A. 自定义目录模式（用户在侧边栏选择过目录且已授权）：直接经文件句柄写入，
//     剧集子目录自动创建，覆盖写；已下载判断变为真实磁盘直查。
//  B. 默认目录模式：组装 Blob 生成 objectURL，交给 service worker 调
//     chrome.downloads 保存（filename 支持子目录）。
// 数据链路：内容脚本 →(to:'sw' 分块)→ SW →(to:'os' 转发)→ 本文档。
import { dirGranted } from './net/fsdir.js';

const saves = new Map();

// 解析 filename（形如 剧名/集名.mp4）到文件句柄；create=false 时仅探测存在性
async function resolveFileHandle(filename, create) {
  const root = await dirGranted();
  if (!root) return null;
  const segs = filename.split('/').filter(Boolean);
  const base = segs.pop();
  let dir = root;
  for (const s of segs) dir = await dir.getDirectoryHandle(s, { create: !!create });
  return dir.getFileHandle(base, { create: !!create });
}

function pushChunk(saveId, b64) {
  const s = saves.get(saveId);
  if (!s) return;
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  s.chunks.push(u8);
}

async function handleOsMessage(msg) {
  if (msg.type === 'os-save-begin') {
    const root = await dirGranted();
    saves.set(msg.saveId, { chunks: [], mime: msg.mime || 'video/mp4', fs: !!root, filename: msg.filename });
    return { ok: true, fs: !!root };
  }
  if (msg.type === 'os-save-chunk') {
    pushChunk(msg.saveId, msg.b64);
    return { ok: true };
  }
  if (msg.type === 'os-save-end') {
    const s = saves.get(msg.saveId);
    if (!s) return { ok: false, error: 'no such save' };
    saves.delete(msg.saveId);
    if (s.fs) {
      try {
        const fh = await resolveFileHandle(s.filename, true);
        const w = await fh.createWritable();
        await w.write(new Blob(s.chunks, { type: s.mime }));
        await w.close();
        chrome.runtime.sendMessage({ to: 'sw', type: 'os-saved', saveId: msg.saveId, ok: true }).catch(() => {});
        return { ok: true };
      } catch (e) {
        chrome.runtime.sendMessage({ to: 'sw', type: 'os-saved', saveId: msg.saveId, ok: false, error: String(e?.message || e) }).catch(() => {});
        return { ok: false, error: String(e?.message || e) };
      }
    }
    const blob = new Blob(s.chunks, { type: s.mime });
    const url = URL.createObjectURL(blob);
    chrome.runtime.sendMessage({ to: 'sw', type: 'os-url', saveId: msg.saveId, url, size: blob.size }).catch(() => {});
    return { ok: true };
  }
  if (msg.type === 'os-revoke') {
    try { URL.revokeObjectURL(msg.url); } catch {}
    return { ok: true };
  }
  if (msg.type === 'os-file-exists') {
    const root = await dirGranted();
    if (!root) return { handled: false };
    try {
      await resolveFileHandle(msg.filename, false);
      return { handled: true, exists: true };
    } catch {
      return { handled: true, exists: false };
    }
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
