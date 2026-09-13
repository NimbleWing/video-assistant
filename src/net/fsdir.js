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

// 真实写探针：创建并立即删除一个探测文件。
// queryPermission 对扩展的 IDB 回读句柄不可靠（两个方向都会虚报），
// 实际能否写入以本探针为准——offscreen 的写入权限与此同源同状态。
export async function probeWritable() {
  const h = await loadDirHandle();
  if (!h) return false;
  const name = '.rv-access-probe';
  try {
    const fh = await h.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(new Blob(['1']));
    await w.close();
    await h.removeEntry(name);
    return true;
  } catch {
    try { await h.removeEntry(name); } catch {}
    return false;
  }
}
