// 内存版 FileSystemDirectoryHandle 树：fswriter/save-session 单测用。
// 语义对齐 FS Access：createWritable 默认截断、keepExistingData 保留；
// 写指针顺序推进、seek 定位覆盖写；move 改名；NotFoundError 抛 DOMException。

/** @param {Uint8Array | string | Blob} data @returns {Promise<Uint8Array>} */
async function toU8(data) {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  // FileSystemWriteChunkType 还可能带 {type:'write', data} 包装——本 mock 只接裸数据
  return new Uint8Array(/** @type {ArrayBuffer} */ (data));
}

class MockFileHandle {
  /**
   * @param {MockDirHandle} dir
   * @param {string} name
   */
  constructor(dir, name) {
    this.kind = 'file';
    this.dir = dir;
    this.name = name;
  }

  /** @returns {Promise<Blob>} */
  async getFile() {
    const data = this.dir.files.get(this.name) || new Uint8Array(0);
    // Blob 原生具备 size/text()/arrayBuffer()，与 File 行为一致
    return new Blob([/** @type {Uint8Array<ArrayBuffer>} */ (data)]);
  }

  /**
   * @param {{ keepExistingData?: boolean }} [opts]
   * @returns {Promise<{ write(data: any): Promise<void>, seek(off: number): Promise<void>, close(): Promise<void> }>}
   */
  async createWritable(opts = {}) {
    const dir = this.dir;
    const name = this.name;
    let buf = opts.keepExistingData ? new Uint8Array(dir.files.get(name) || []) : new Uint8Array(0);
    let pos = 0;
    let closed = false;
    return {
      /** @param {any} data */
      async write(data) {
        if (closed) throw new DOMException('已关闭', 'InvalidStateError');
        const u8 = await toU8(data);
        const need = pos + u8.length;
        if (need > buf.length) {
          const nb = new Uint8Array(need);
          nb.set(buf);
          buf = nb;
        }
        buf.set(u8, pos);
        pos += u8.length;
      },
      /** @param {number} off */
      async seek(off) { pos = off; },
      async close() {
        closed = true;
        // buf 只增不减：seek 回改是原位覆盖，文件长度 = 历史最大写入位置
        dir.files.set(name, buf);
      },
    };
  }

  /** @param {string} newName */
  async move(newName) {
    const data = this.dir.files.get(this.name);
    if (data === undefined) throw new DOMException('不存在', 'NotFoundError');
    this.dir.files.delete(this.name);
    this.dir.files.set(newName, data);
    this.name = newName;
  }
}

class MockDirHandle {
  /** @param {string} name */
  constructor(name) {
    this.kind = 'directory';
    this.name = name;
    /** @type {Map<string, MockDirHandle>} */
    this.dirs = new Map();
    /** @type {Map<string, Uint8Array>} */
    this.files = new Map();
  }

  /**
   * @param {string} name
   * @param {{ create?: boolean }} [opts]
   * @returns {Promise<MockDirHandle>}
   */
  async getDirectoryHandle(name, opts = {}) {
    let d = this.dirs.get(name);
    if (!d) {
      if (!opts.create) throw new DOMException('目录不存在', 'NotFoundError');
      d = new MockDirHandle(name);
      this.dirs.set(name, d);
    }
    return d;
  }

  /**
   * @param {string} name
   * @param {{ create?: boolean }} [opts]
   * @returns {Promise<MockFileHandle>}
   */
  async getFileHandle(name, opts = {}) {
    if (!this.files.has(name) && !opts.create) throw new DOMException('文件不存在', 'NotFoundError');
    if (!this.files.has(name)) this.files.set(name, new Uint8Array(0));
    return new MockFileHandle(this, name);
  }

  /** @param {string} name */
  async removeEntry(name) {
    if (!this.files.delete(name) && !this.dirs.delete(name)) {
      throw new DOMException('条目不存在', 'NotFoundError');
    }
  }
}

/**
 * @returns {{ root: FileSystemDirectoryHandle, dump(): Record<string, number[]> }}
 */
export function makeFsMock() {
  const root = new MockDirHandle('root');
  return {
    root: /** @type {any} */ (root),
    /** 快照当前树：路径 → 字节数组（断言用） */
    dump() {
      /** @type {Record<string, number[]>} */
      const out = {};
      /** @param {MockDirHandle} d @param {string} prefix */
      const walk = (d, prefix) => {
        for (const [name, data] of d.files) out[prefix + name] = Array.from(data);
        for (const [name, sub] of d.dirs) walk(sub, `${prefix}${name}/`);
      };
      walk(root, '');
      return out;
    },
  };
}
