// 自定义下载目录（File System Access API）。
// 句柄存 IndexedDB（扩展源内共享）：面板负责挑选/授权，offscreen 负责实际读写。
const DB_NAME = 'rv-fs';
const STORE = 'handles';
const KEY = 'dir';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return idbOpen().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(req?.result); };
    t.onerror = () => { db.close(); reject(t.error); };
  }));
}

export async function loadDirHandle() {
  try { return (await tx('readonly', (s) => s.get(KEY))) || null; } catch { return null; }
}

export async function saveDirHandle(handle) {
  await tx('readwrite', (s) => s.put(handle, KEY));
}

export async function clearDirHandle() {
  try { await tx('readwrite', (s) => s.delete(KEY)); } catch {}
}

// null = 未设置自定义目录；false = 已设置但未授权（浏览器重启后需重新授权）；
// handle = 已授权可用。
export async function dirGranted() {
  const h = await loadDirHandle();
  if (!h) return null;
  try {
    return (await h.queryPermission({ mode: 'readwrite' })) === 'granted' ? h : false;
  } catch {
    return false;
  }
}
