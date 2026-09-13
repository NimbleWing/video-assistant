// 自定义目录流式写入器：.part 半成品 + sidecar 快照 + 完成后 rename。
// 句柄经 fsdir.js 的 IDB 共享；本模块不碰 chrome.*，纯 FS Access 逻辑（可单测）。
// 半成品布局（stem = 去掉 .mp4 的路径）：
//   写入中：<stem>.part（mp4 模式：ftyp|mdat头|mdat…；ts 透传：裸 TS）
//   快照：  <stem>.part.json（指纹/进度/remux 元数据，断点续传凭据）
//   完成：  rename 为 <stem>.mp4 或 <stem>.ts

/**
 * @typedef {Object} DirEntry
 * @property {FileSystemDirectoryHandle} dir
 * @property {string} base 文件名（末段）
 */

/**
 * 按 "a/b/c.mp4" 逐级定位目录（create 时自动建目录）。
 * @param {FileSystemDirectoryHandle} root
 * @param {string} filename
 * @param {boolean} create
 * @returns {Promise<DirEntry | null>} 目录不存在且未要求创建时为 null
 */
export async function resolveDir(root, filename, create) {
  const segs = filename.split('/').filter(Boolean);
  const base = /** @type {string} */ (segs.pop());
  let dir = root;
  for (const s of segs) {
    dir = await dir.getDirectoryHandle(s, { create });
  }
  return { dir, base };
}

/**
 * 文件是否存在。
 * @param {FileSystemDirectoryHandle} root
 * @param {string} filename
 * @returns {Promise<boolean>}
 */
export async function fsFileExists(root, filename) {
  try {
    const e = await resolveDir(root, filename, false);
    if (!e) return false;
    await e.dir.getFileHandle(e.base, { create: false });
    return true;
  } catch (e) {
    if ((/** @type {any} */ (e))?.name === 'NotFoundError') return false;
    throw e; // NotAllowedError 等向上抛（调用方映射 REAUTH）
  }
}

/**
 * 读 JSON 文件；不存在返回 null。
 * @param {FileSystemDirectoryHandle} root
 * @param {string} filename
 * @returns {Promise<any>}
 */
export async function fsReadJson(root, filename) {
  try {
    const e = await resolveDir(root, filename, false);
    if (!e) return null;
    const fh = await e.dir.getFileHandle(e.base, { create: false });
    const f = await fh.getFile();
    return JSON.parse(await f.text());
  } catch (e) {
    if ((/** @type {any} */ (e))?.name === 'NotFoundError') return null;
    throw e;
  }
}

/**
 * 写 JSON 文件（截断覆盖）。
 * @param {FileSystemDirectoryHandle} root
 * @param {string} filename
 * @param {any} obj
 * @returns {Promise<void>}
 */
export async function fsWriteJson(root, filename, obj) {
  const e = await resolveDir(root, filename, true);
  if (!e) throw new Error('目录解析失败');
  const fh = await e.dir.getFileHandle(e.base, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(obj));
  await w.close();
}

/**
 * 删除文件（不存在则忽略）。
 * @param {FileSystemDirectoryHandle} root
 * @param {string} filename
 * @returns {Promise<void>}
 */
export async function fsRemove(root, filename) {
  try {
    const e = await resolveDir(root, filename, false);
    if (!e) return;
    await e.dir.removeEntry(e.base);
  } catch (e) {
    if ((/** @type {any} */ (e))?.name === 'NotFoundError') return;
    throw e;
  }
}

/**
 * 流式文件写入器：顺序写 + seek 补丁 + 完成后改名。
 */
export class FsStreamWriter {
  /**
   * @param {FileSystemDirectoryHandle} dir
   * @param {FileSystemFileHandle} handle
   * @param {FileSystemWritableFileStream} w
   * @param {string} name
   * @param {number} position
   */
  constructor(dir, handle, w, name, position) {
    this.dir = dir;
    this.handle = handle;
    this.w = w;
    this.name = name;
    this.position = position;
    this.closed = false;
  }

  /**
   * 新建（截断）并从头写。
   * @param {FileSystemDirectoryHandle} root
   * @param {string} filename
   * @returns {Promise<FsStreamWriter>}
   */
  static async create(root, filename) {
    const e = await resolveDir(root, filename, true);
    if (!e) throw new Error('目录解析失败');
    const handle = await e.dir.getFileHandle(e.base, { create: true });
    const w = await handle.createWritable();
    return new FsStreamWriter(e.dir, handle, w, e.base, 0);
  }

  /**
   * 追加恢复：校验现有大小与预期一致（不一致 = 半成品损坏，返回 null 让调用方重来）。
   * @param {FileSystemDirectoryHandle} root
   * @param {string} filename
   * @param {number} expectedSize
   * @returns {Promise<FsStreamWriter | null>}
   */
  static async resume(root, filename, expectedSize) {
    try {
      const e = await resolveDir(root, filename, false);
      if (!e) return null;
      const handle = await e.dir.getFileHandle(e.base, { create: false });
      const f = await handle.getFile();
      if (f.size !== expectedSize) return null;
      const w = await handle.createWritable({ keepExistingData: true });
      await w.seek(expectedSize);
      return new FsStreamWriter(e.dir, handle, w, e.base, expectedSize);
    } catch (e) {
      if ((/** @type {any} */ (e))?.name === 'NotFoundError') return null;
      throw e;
    }
  }

  /**
   * @param {Uint8Array} u8
   * @returns {Promise<void>}
   */
  async write(u8) {
    if (this.closed) throw new Error('写入器已关闭');
    await this.w.write(/** @type {Uint8Array<ArrayBuffer>} */ (u8));
    this.position += u8.length;
  }

  /**
   * @param {number} off
   * @returns {Promise<void>}
   */
  async seek(off) {
    if (this.closed) throw new Error('写入器已关闭');
    await this.w.seek(off);
    this.position = off;
  }

  /** @returns {Promise<void>} */
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.w.close();
  }

  /**
   * 改名为最终文件名（Chrome 122+ move；老内核复制+删除兜底）。
   * @param {string} finalName
   * @returns {Promise<void>}
   */
  async moveTo(finalName) {
    await this.close();
    const handle = /** @type {any} */ (this.handle);
    if (typeof handle.move === 'function') {
      await handle.move(finalName);
      return;
    }
    // 兜底：流式复制到目标名再删原件
    const src = await this.handle.getFile();
    const dstHandle = await this.dir.getFileHandle(finalName, { create: true });
    const dst = await dstHandle.createWritable();
    await dst.write(src);
    await dst.close();
    await this.dir.removeEntry(this.name);
  }

  /**
   * 丢弃半成品（关闭并删除）。
   * @returns {Promise<void>}
   */
  async discard() {
    try { await this.close(); } catch {}
    await this.dir.removeEntry(this.name).catch(() => {});
  }
}
