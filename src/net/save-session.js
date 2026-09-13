// 保存会话编排（OPFS 单后端）：解密 TS 分段 →（流式 remux）→ OPFS .part 写盘
// → moov 置尾 → rename → 经注入的 finalizeViaDownloads 钩子交 chrome.downloads
// 落到浏览器下载目录（子目录保留）。OPFS 为扩展私有磁盘存储，永不需要授权。
//
// 模式：undecided → 首几段验证 remux 可行性（见 SPS/PPS），通过 → mp4；
//       超 VALIDATE_LIMIT 仍未验证 → ts 透传（HEVC/fMP4 兜底）。
// 半成品：<stem>.part + <stem>.part.json（sidecar，均在 OPFS）。
// 断点续传：abort/失败保留半成品，重试时指纹一致即从断点续写。

import { TsRemux } from '../hls/ts-remux.js';
import {
  FsStreamWriter, fsReadJson, fsRemove, fsWriteJson, resolveDir,
} from './fswriter.js';

/** remux 验证上限：推入超过该字节仍未见 SPS/PPS → 按 TS 透传 */
const VALIDATE_LIMIT = 32 * 1024 * 1024;
/** sidecar 持久化节流（每 N 段一次；abort 时总会补一次） */
const SIDECAR_EVERY = 10;
const SIDECAR_VERSION = 1;

/**
 * @typedef {import('../hls/ts-remux.js').RemuxSnapshot} RemuxSnapshot
 */

/**
 * @typedef {Object} SaveSessionInfo
 * @property {string} fingerprint 播放列表指纹（防续传串片）
 * @property {number} segTotal 分段总数
 */

/**
 * @typedef {Object} SaveSessionOpts
 * @property {number} [validateLimit] 仅测试注入
 * @property {() => Promise<FileSystemDirectoryHandle>} [getOpfsRoot] OPFS 根获取（默认 navigator.storage，测试注入）
 * @property {(filename: string, file: Blob) => Promise<{ ok: boolean, error?: string }>} [finalizeViaDownloads]
 *   完成文件的落盘钩子（offscreen 注入：objectURL → SW chrome.downloads）
 */

/**
 * @typedef {Object} BeginResult
 * @property {SaveSession} session
 * @property {number} resumeFrom 从第几段续传（0 = 全新）
 */

/**
 * @typedef {Object} FinalResult
 * @property {string} finalName 最终文件名（含子目录）
 * @property {string} note 附加说明（透传提示）
 */

export class SaveSession {
  /**
   * @param {FileSystemDirectoryHandle} root OPFS 根
   * @param {string} stem 去扩展名路径（可含子目录，如 "剧名/第1集"）
   * @param {SaveSessionInfo} info
   * @param {SaveSessionOpts} opts
   */
  constructor(root, stem, info, opts) {
    this.root = root;
    this.stem = stem;
    this.info = info;
    this.opts = opts;
    this.validateLimit = opts.validateLimit || VALIDATE_LIMIT;
    /** @type {import('../hls/ts-remux.js').StreamingRemuxSession | null} */
    this.remux = TsRemux.createStreamingRemux();
    /** @type {FsStreamWriter | null} */
    this.writer = null;
    /** @type {Uint8Array[]} 验证前缓冲（≤ VALIDATE_LIMIT） */
    this.rawBuf = [];
    /** @type {Uint8Array[]} 验证前 remux 冲刷出的 mdat（验证通过才落盘） */
    this.mdatBuf = [];
    this.pushedBytes = 0;
    this.segmentsDone = 0;
    this.headerBytes = 0;
    this.closed = false;
  }

  /** @returns {string} */
  get partName() { return `${this.stem}.part`; }

  /** @returns {string} */
  get sidecarName() { return `${this.stem}.part.json`; }

  /**
   * 开始保存会话：续传恢复 → 全新。
   * @param {string} filename provisional 名（.mp4 结尾，可含子目录）
   * @param {SaveSessionInfo} info
   * @param {SaveSessionOpts} [opts]
   * @returns {Promise<BeginResult>}
   */
  static async begin(filename, info, opts = {}) {
    const stem = filename.replace(/\.mp4$/i, '');
    const getRoot = opts.getOpfsRoot || (async () => /** @type {FileSystemDirectoryHandle} */ (await navigator.storage.getDirectory()));
    const root = await getRoot();
    const session = new SaveSession(root, stem, info, opts);
    const sc = await fsReadJson(root, session.sidecarName).catch(() => null);
    if (sc && sc.version === SIDECAR_VERSION && sc.fingerprint === info.fingerprint && sc.segTotal === info.segTotal) {
      const resumed = await session.#tryResume(sc);
      if (resumed) return resumed;
    }
    // 快照不可用（.part 缺失/大小不符）→ 废弃重来
    await fsRemove(root, session.partName).catch(() => {});
    await fsRemove(root, session.sidecarName).catch(() => {});
    return { session, resumeFrom: 0 };
  }

  /**
   * @param {any} sc
   * @returns {Promise<BeginResult | null>}
   */
  async #tryResume(sc) {
    if (sc.mode === 'mp4' && sc.remux && sc.headerBytes > 0) {
      const expected = sc.headerBytes + sc.remux.mdatPayload;
      const writer = await FsStreamWriter.resume(this.root, this.partName, expected);
      if (writer) {
        this.writer = writer;
        this.headerBytes = sc.headerBytes;
        this.remux = TsRemux.createStreamingRemux(/** @type {RemuxSnapshot} */ (sc.remux));
        this.segmentsDone = sc.segmentsDone || 0;
        return { session: this, resumeFrom: this.segmentsDone };
      }
    } else if (sc.mode === 'ts' && sc.bytes > 0) {
      const writer = await FsStreamWriter.resume(this.root, this.partName, sc.bytes);
      if (writer) {
        this.writer = writer;
        this.remux = null; // 透传续传：不走 remux
        this.pushedBytes = sc.bytes;
        this.segmentsDone = sc.segmentsDone || 0;
        return { session: this, resumeFrom: this.segmentsDone };
      }
    }
    return null;
  }

  /** @returns {Promise<void>} */
  async #switchToMp4() {
    const writer = await FsStreamWriter.create(this.root, this.partName);
    const remux = this.#needRemux();
    const ftyp = remux.ftyp;
    const hdr = new Uint8Array(remux.mdatHeaderSize);
    new DataView(hdr.buffer).setUint32(0, 1); // largesize 标记
    hdr[4] = 0x6d; hdr[5] = 0x64; hdr[6] = 0x61; hdr[7] = 0x74; // 'mdat'
    await writer.write(ftyp);
    await writer.write(hdr);
    for (const c of this.mdatBuf) await writer.write(c);
    this.mdatBuf = [];
    this.rawBuf = [];
    this.headerBytes = ftyp.length + remux.mdatHeaderSize;
    this.writer = writer;
  }

  /** @returns {Promise<void>} */
  async #switchToTs() {
    const writer = await FsStreamWriter.create(this.root, this.partName);
    for (const c of this.rawBuf) await writer.write(c);
    this.rawBuf = [];
    this.mdatBuf = [];
    this.remux = null; // 透传不再需要 remux
    this.writer = writer;
  }
  /** @returns {import('../hls/ts-remux.js').StreamingRemuxSession} */
  #needRemux() {
    if (!this.remux) throw new Error('内部状态错误：remux 为空');
    return this.remux;
  }
  /** @returns {'undecided' | 'mp4' | 'ts'} */
  get mode() {
    if (!this.writer) return 'undecided';
    return this.remux ? 'mp4' : 'ts';
  }

  /**
   * 推入一个解密后的分段（严格按播放列表顺序）。
   * @param {Uint8Array} u8
   * @returns {Promise<void>}
   */
  async pushSegment(u8) {
    if (this.closed) throw new Error('会话已关闭');
    this.segmentsDone += 1;
    if (this.mode === 'undecided') {
      this.rawBuf.push(u8);
      this.pushedBytes += u8.length;
      this.mdatBuf.push(...this.#needRemux().push(u8));
      if (this.#needRemux().validated) await this.#switchToMp4();
      else if (this.pushedBytes >= this.validateLimit) await this.#switchToTs();
      return;
    }
    if (this.mode === 'mp4') {
      const writer = /** @type {FsStreamWriter} */ (this.writer);
      for (const c of this.#needRemux().push(u8)) await writer.write(c);
      // 每段检查点（quiesce demux → 快照一致）；sidecar 节流持久化
      const cp = this.#needRemux().checkpoint();
      for (const c of cp.mdat) await writer.write(c);
      if (this.segmentsDone % SIDECAR_EVERY === 0) {
        await fsWriteJson(this.root, this.sidecarName, {
          version: SIDECAR_VERSION,
          fingerprint: this.info.fingerprint,
          segTotal: this.info.segTotal,
          segmentsDone: this.segmentsDone,
          mode: 'mp4',
          remux: cp.snapshot,
          headerBytes: this.headerBytes,
          updatedAt: Date.now(),
        });
      }
      return;
    }
    // ts 透传
    const writer = /** @type {FsStreamWriter} */ (this.writer);
    await writer.write(u8);
    this.pushedBytes += u8.length;
    if (this.segmentsDone % SIDECAR_EVERY === 0) {
      await fsWriteJson(this.root, this.sidecarName, {
        version: SIDECAR_VERSION,
        fingerprint: this.info.fingerprint,
        segTotal: this.info.segTotal,
        segmentsDone: this.segmentsDone,
        mode: 'ts',
        bytes: this.pushedBytes,
        updatedAt: Date.now(),
      });
    }
  }

  /** @returns {Promise<FinalResult>} */
  async #finishTs() {
    const writer = /** @type {FsStreamWriter} */ (this.writer);
    await writer.moveTo(`${this.stem.split('/').pop()}.ts`);
    return await this.#finishViaDownloads('ts');
  }

  /**
   * @param {{ mdat: Uint8Array[], moov: Uint8Array, mdatPayload: number }} fin
   * @param {boolean} mdatPending fin.mdat 是否尚未落盘
   * @returns {Promise<FinalResult>}
   */
  async #finishMp4(fin, mdatPending) {
    const writer = /** @type {FsStreamWriter} */ (this.writer);
    if (mdatPending) for (const c of fin.mdat) await writer.write(c);
    // 补丁 mdat largesize（box 总长 = 头 16 + 负载）
    const ftypLen = this.headerBytes - this.#needRemux().mdatHeaderSize;
    const total = fin.mdatPayload + this.#needRemux().mdatHeaderSize;
    const patch = new Uint8Array(8);
    const dv = new DataView(patch.buffer);
    dv.setUint32(0, Math.floor(total / 4294967296));
    dv.setUint32(4, total % 4294967296);
    await writer.seek(ftypLen + 8);
    await writer.write(patch);
    await writer.seek(this.headerBytes + fin.mdatPayload);
    await writer.write(fin.moov);
    await writer.moveTo(`${this.stem.split('/').pop()}.mp4`);
    return await this.#finishViaDownloads('mp4');
  }

  /**
   * OPFS 内 rename 完整文件 → 取 Blob → 注入钩子落 chrome.downloads → 清理 OPFS。
   * @param {'mp4' | 'ts'} ext
   * @returns {Promise<FinalResult>}
   */
  async #finishViaDownloads(ext) {
    const finalize = this.opts.finalizeViaDownloads;
    if (!finalize) throw new Error('未注入落盘钩子');
    const writer = /** @type {FsStreamWriter} */ (this.writer);
    const base = /** @type {string} */ (this.stem.split('/').pop());
    await writer.moveTo(`${base}.${ext}`);
    // 取回完整文件（磁盘态 Blob，不占内存）
    const e = await resolveDir(this.root, `${this.stem}.${ext}`, false);
    if (!e) throw new Error('OPFS 完成文件缺失');
    const fh = await e.dir.getFileHandle(e.base, { create: false });
    const file = await fh.getFile();
    const r = await finalize(`${this.stem}.${ext}`, file);
    await fsRemove(this.root, `${this.stem}.${ext}`).catch(() => {});
    await fsRemove(this.root, this.sidecarName).catch(() => {});
    if (!r.ok) throw new Error(r.error || '落盘失败');
    return {
      finalName: `${this.stem}.${ext}`,
      note: ext === 'ts' ? '非可封装的 MPEG-TS 流，已保存为 TS' : '',
    };
  }

  /**
   * 收尾：补丁 largesize + 写 moov → rename → downloads 落盘。失败会清理半成品。
   * @returns {Promise<FinalResult>}
   */
  async finalize() {
    if (this.closed) throw new Error('会话已关闭');
    this.closed = true;
    try {
      if (this.mode === 'undecided') {
        // 小体量未触发切换：全量已在手，remux 成败一锤定音
        /** @type {{ mdat: Uint8Array[], moov: Uint8Array, mdatPayload: number } | null} */
        let fin = null;
        try { fin = this.#needRemux().finalize(); } catch { /* 落透传 */ }
        if (!fin) {
          await this.#switchToTs();
          return await this.#finishTs();
        }
        this.mdatBuf.push(...fin.mdat);
        await this.#switchToMp4();
        return await this.#finishMp4(fin, false);
      }
      if (this.mode === 'ts') return await this.#finishTs();
      return await this.#finishMp4(this.#needRemux().finalize(), true);
    } catch (e) {
      await this.discard().catch(() => {});
      throw e;
    }
  }

  /**
   * 中止：保留 .part + sidecar（断点续传凭据）。undecided 阶段未落盘，直接清理内存。
   * @returns {Promise<void>}
   */
  async abort() {
    if (this.closed) return;
    this.closed = true;
    if (this.mode === 'mp4') {
      const writer = /** @type {FsStreamWriter} */ (this.writer);
      // 补一次含检查点的 sidecar（分段边界语义无损）
      const cp = this.remux ? this.remux.checkpoint() : null;
      /** @type {Record<string, any>} */
      const sc = {
        version: SIDECAR_VERSION,
        fingerprint: this.info.fingerprint,
        segTotal: this.info.segTotal,
        segmentsDone: this.segmentsDone,
        mode: this.mode,
        updatedAt: Date.now(),
      };
      if (cp) {
        for (const c of cp.mdat) await writer.write(c);
        sc.remux = cp.snapshot;
        sc.headerBytes = this.headerBytes;
      }
      await fsWriteJson(this.root, this.sidecarName, sc).catch(() => {});
      await writer.close().catch(() => {});
    } else if (this.mode === 'ts') {
      await fsWriteJson(this.root, this.sidecarName, {
        version: SIDECAR_VERSION,
        fingerprint: this.info.fingerprint,
        segTotal: this.info.segTotal,
        segmentsDone: this.segmentsDone,
        mode: 'ts',
        bytes: this.pushedBytes,
        updatedAt: Date.now(),
      }).catch(() => {});
      await /** @type {FsStreamWriter} */ (this.writer).close().catch(() => {});
    }
    this.rawBuf = [];
    this.mdatBuf = [];
  }

  /**
   * 丢弃：删除半成品与快照（finalize 失败等不可续场景）。
   * @returns {Promise<void>}
   */
  async discard() {
    if (this.writer) await this.writer.discard().catch(() => {});
    await fsRemove(this.root, this.partName).catch(() => {});
    await fsRemove(this.root, this.sidecarName).catch(() => {});
    this.rawBuf = [];
    this.mdatBuf = [];
    this.closed = true;
  }
}
