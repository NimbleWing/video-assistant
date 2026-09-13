// 保存会话编排：解密 TS 分段 →（流式 remux）→ .part 写盘 → moov 置尾 → rename。
// 纯逻辑（目录句柄注入），offscreen 只做消息 plumbing。
//
// 模式：
//   undecided → 首几段验证 remux 可行性（见 SPS/PPS），通过 → mp4；
//               超 VALIDATE_LIMIT 仍未验证 → ts 透传（HEVC/fMP4 等）。
// 半成品：<stem>.part + <stem>.part.json（sidecar），完成后 rename 为 <stem>.mp4/.ts。
// 续传：abort/失败保留 .part+sidecar；begin 时指纹一致且大小吻合 → 从 segmentsDone 续写。

import { TsRemux } from '../hls/ts-remux.js';
import {
  FsStreamWriter, fsFileExists, fsReadJson, fsRemove, fsWriteJson,
} from './fswriter.js';

/** remux 验证上限：推入超过该字节仍未见 SPS/PPS → 按 TS 透传（HEVC/fMP4 兜底） */
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
 * @typedef {Object} BeginResult
 * @property {SaveSession} session
 * @property {number} resumeFrom 从第几段续传（0 = 全新）
 * @property {boolean} done 最终文件已存在（调用方直接跳过）
 */

/**
 * @typedef {Object} FinalResult
 * @property {string} finalName 最终文件名（含子目录）
 * @property {string} note 附加说明（透传时给出）
 */

export class SaveSession {
  /**
   * @param {FileSystemDirectoryHandle} root
   * @param {string} stem 去扩展名路径（可含子目录，如 "剧名/第1集"）
   * @param {SaveSessionInfo} info
   * @param {{ validateLimit?: number }} [opts] validateLimit 仅测试注入
   */
  constructor(root, stem, info, opts = {}) {
    this.root = root;
    this.stem = stem;
    this.info = info;
    this.validateLimit = opts.validateLimit || VALIDATE_LIMIT;
    /** @type {'undecided' | 'mp4' | 'ts'} */
    this.mode = 'undecided';
    /** @type {import('../hls/ts-remux.js').StreamingRemuxSession | null} */
    this.remux = null;
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
   * 开始保存会话：已存在判定 → 续传恢复 → 全新。
   * @param {FileSystemDirectoryHandle} root
   * @param {string} filename  provisional 名（.mp4 结尾，可含子目录）
   * @param {SaveSessionInfo} info
   * @param {{ validateLimit?: number }} [opts]
   * @returns {Promise<BeginResult>}
   */
  static async begin(root, filename, info, opts = {}) {
    const stem = filename.replace(/\.mp4$/i, '');
    // 双查（dedup 第二道防线，防竞态重复下载）
    if (await fsFileExists(root, `${stem}.mp4`) || await fsFileExists(root, `${stem}.ts`)) {
      return { session: new SaveSession(root, stem, info, opts), resumeFrom: 0, done: true };
    }
    const session = new SaveSession(root, stem, info, opts);
    const sc = await fsReadJson(root, session.sidecarName).catch(() => null);
    if (sc && sc.version === SIDECAR_VERSION && sc.fingerprint === info.fingerprint && sc.segTotal === info.segTotal) {
      if (sc.mode === 'mp4' && sc.remux && sc.headerBytes > 0) {
        const expected = sc.headerBytes + sc.remux.mdatPayload;
        const writer = await FsStreamWriter.resume(root, session.partName, expected);
        if (writer) {
          session.mode = 'mp4';
          session.writer = writer;
          session.headerBytes = sc.headerBytes;
          session.remux = TsRemux.createStreamingRemux(/** @type {RemuxSnapshot} */ (sc.remux));
          session.segmentsDone = sc.segmentsDone || 0;
          return { session, resumeFrom: session.segmentsDone, done: false };
        }
      } else if (sc.mode === 'ts' && sc.bytes > 0) {
        const writer = await FsStreamWriter.resume(root, session.partName, sc.bytes);
        if (writer) {
          session.mode = 'ts';
          session.writer = writer;
          session.pushedBytes = sc.bytes;
          session.segmentsDone = sc.segmentsDone || 0;
          return { session, resumeFrom: session.segmentsDone, done: false };
        }
      }
      // 快照不可用（.part 缺失/大小不符）→ 废弃重来
    }
    await fsRemove(root, session.partName).catch(() => {});
    await fsRemove(root, session.sidecarName).catch(() => {});
    session.remux = TsRemux.createStreamingRemux();
    return { session, resumeFrom: 0, done: false };
  }

  /** @returns {Promise<void>} */
  async #switchToMp4() {
    const writer = await FsStreamWriter.create(this.root, this.partName);
    const remux = /** @type {import('../hls/ts-remux.js').StreamingRemuxSession} */ (this.remux);
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
    this.mode = 'mp4';
  }

  /** @returns {Promise<void>} */
  async #switchToTs() {
    const writer = await FsStreamWriter.create(this.root, this.partName);
    for (const c of this.rawBuf) await writer.write(c);
    this.rawBuf = [];
    this.mdatBuf = [];
    this.remux = null; // 透传不再需要 remux
    this.writer = writer;
    this.mode = 'ts';
  }

  /** @returns {Promise<void>} */
  async #persistSidecar() {
    /** @type {Record<string, any>} */
    const sc = {
      version: SIDECAR_VERSION,
      fingerprint: this.info.fingerprint,
      segTotal: this.info.segTotal,
      segmentsDone: this.segmentsDone,
      mode: this.mode,
      updatedAt: Date.now(),
    };
    if (this.mode === 'mp4') {
      // 检查点静默 demux 后快照（ abort/节流共用；仅在分段边界调用）
      const cp = this.remux ? this.remux.checkpoint() : null;
      if (cp) {
        for (const c of cp.mdat) await /** @type {FsStreamWriter} */ (this.writer).write(c);
        sc.remux = cp.snapshot;
        sc.headerBytes = this.headerBytes;
      }
    } else if (this.mode === 'ts') {
      sc.bytes = this.pushedBytes;
    }
    await fsWriteJson(this.root, this.sidecarName, sc);
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
      const remux = /** @type {import('../hls/ts-remux.js').StreamingRemuxSession} */ (this.remux);
      this.mdatBuf.push(...remux.push(u8));
      if (remux.validated) await this.#switchToMp4();
      else if (this.pushedBytes >= this.validateLimit) await this.#switchToTs();
      return;
    }
    if (this.mode === 'mp4') {
      const remux = /** @type {import('../hls/ts-remux.js').StreamingRemuxSession} */ (this.remux);
      const writer = /** @type {FsStreamWriter} */ (this.writer);
      for (const c of remux.push(u8)) await writer.write(c);
      // 每段检查点（quiesce demux → 快照一致）；sidecar 节流持久化
      const cp = remux.checkpoint();
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
    await fsRemove(this.root, this.sidecarName).catch(() => {});
    return { finalName: `${this.stem}.ts`, note: '非可封装的 MPEG-TS 流，已保存为 TS' };
  }

  /**
   * @param {{ mdat: Uint8Array[], moov: Uint8Array, mdatPayload: number }} fin
   * @param {boolean} mdatPending fin.mdat 是否尚未落盘
   * @returns {Promise<FinalResult>}
   */
  async #finishMp4(fin, mdatPending) {
    const remux = /** @type {import('../hls/ts-remux.js').StreamingRemuxSession} */ (this.remux);
    const writer = /** @type {FsStreamWriter} */ (this.writer);
    if (mdatPending) for (const c of fin.mdat) await writer.write(c);
    // 补丁 mdat largesize（box 总长 = 头 16 + 负载）
    const ftypLen = this.headerBytes - remux.mdatHeaderSize;
    const total = fin.mdatPayload + remux.mdatHeaderSize;
    const patch = new Uint8Array(8);
    const dv = new DataView(patch.buffer);
    dv.setUint32(0, Math.floor(total / 4294967296));
    dv.setUint32(4, total % 4294967296);
    await writer.seek(ftypLen + 8);
    await writer.write(patch);
    await writer.seek(this.headerBytes + fin.mdatPayload);
    await writer.write(fin.moov);
    await writer.moveTo(`${this.stem.split('/').pop()}.mp4`);
    await fsRemove(this.root, this.sidecarName).catch(() => {});
    return { finalName: `${this.stem}.mp4`, note: '' };
  }

  /**
   * 收尾：补丁 largesize + 写 moov → rename；ts 直接 rename。失败会清理半成品。
   * @returns {Promise<FinalResult>}
   */
  async finalize() {
    if (this.closed) throw new Error('会话已关闭');
    this.closed = true;
    try {
      if (this.mode === 'undecided') {
        // 小体量未触发切换：全量已在手，remux 成败一锤定音
        const remux = /** @type {import('../hls/ts-remux.js').StreamingRemuxSession} */ (this.remux);
        /** @type {{ mdat: Uint8Array[], moov: Uint8Array, mdatPayload: number } | null} */
        let fin = null;
        try { fin = remux.finalize(); } catch { /* 落透传 */ }
        if (!fin) {
          await this.#switchToTs();
          return await this.#finishTs();
        }
        this.mdatBuf.push(...fin.mdat);
        await this.#switchToMp4();
        return await this.#finishMp4(fin, false);
      }
      if (this.mode === 'ts') return await this.#finishTs();
      const remux = /** @type {import('../hls/ts-remux.js').StreamingRemuxSession} */ (this.remux);
      return await this.#finishMp4(remux.finalize(), true);
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
    if (this.mode === 'mp4' || this.mode === 'ts') {
      await this.#persistSidecar().catch(() => {});
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
