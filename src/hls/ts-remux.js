// Minimal MPEG-TS → MP4 (H.264/AAC) remuxer, ported unchanged from the
// userscript. Demuxes TS packets into AVC/AAC samples and muxes a plain MP4.
//
// 两条路径：
//  - 单遍 remux()：整段 TS 进、整文件出（测试与小型输入用）。
//  - 流式 createStreamingRemux()：分段 TS 增量流入 → mdat 增量流出，样本元数据
//    （游程时长 + 尺寸 + 偏移 + 关键帧）常驻内存，finalize 算出 moov（置尾，
//    stco 收尾时天然已知、零补丁）。snapshot()/恢复支撑断点续传。

/**
 * @typedef {Object} VideoSample
 * @property {Uint8Array} data AVCC 格式（长度前缀 NAL）
 * @property {number} pts 90kHz 时钟
 * @property {boolean} isKey
 */

/**
 * @typedef {Object} AudioSample
 * @property {Uint8Array} data AAC 裸帧（去 ADTS 头）
 * @property {number} pts 90kHz 时钟
 */

/**
 * @typedef {Object} StreamMeta
 * @property {number} width
 * @property {number} height
 * @property {number} profile
 * @property {number} level
 * @property {Uint8Array | undefined} sps
 * @property {Uint8Array | undefined} pps
 * @property {number} sampleRate
 * @property {number} channels
 * @property {number} aacProfile
 */

/**
 * @typedef {Object} Demuxed
 * @property {VideoSample[]} video
 * @property {AudioSample[]} audio
 * @property {StreamMeta} meta
 */

/**
 * @typedef {Object} PesStream
 * @property {number} sid PES stream_id
 * @property {Uint8Array[]} chunks
 * @property {number} len
 * @property {{ off: number, pts: number }[]} ptsAt
 */

/** 时长游程（stts 条目） @typedef {Object} RleEntry @property {number} cnt @property {number} dur */

/**
 * 合成偏移游程（ctts 条目） @typedef {Object} CttsEntry @property {number} cnt @property {number} off（pts − dts，≥0） */

/**
 * @typedef {Object} StreamingRemuxSession
 * @property {Uint8Array} ftyp 文件头（stco 基准，长度恒定）
 * @property {number} mdatHeaderSize mdat 头长（largesize 模式）
 * @property {number} mdatPayload 已写 mdat 负载字节
 * @property {boolean} validated remux 可行性已验证（见到 SPS/PPS 与 VCL）
 * @property {(u8: Uint8Array) => Uint8Array[]} push 推入一段 TS 字节，返回冲刷出的 mdat 块
 * @property {() => { mdat: Uint8Array[], moov: Uint8Array, mdatPayload: number }} finalize 收尾并构建 moov（置尾）
 * @property {() => { mdat: Uint8Array[], snapshot: RemuxSnapshot }} checkpoint 分段边界检查点（可续传快照）
 */

/**
 * 流式会话快照（sidecar 持久化，分段边界恢复——demux 状态不持久化）。
 * @typedef {Object} RemuxSnapshot
 * @property {number} width
 * @property {number} height
 * @property {number} profile
 * @property {number} level
 * @property {number} sampleRate
 * @property {number} channels
 * @property {number} aacProfile
 * @property {string} sps base64（空串 = 未见）
 * @property {string} pps base64（空串 = 未见）
 * @property {number[]} vSizes
 * @property {number[]} vOffs mdat 负载内偏移
 * @property {RleEntry[]} vRLE
 * @property {number[]} [vPts] 逐样本 PTS（v1.11.4 起，B 帧重排时间轴用；旧快照缺省 = 回退旧逻辑）
 * @property {number[]} vKeys 1-based 关键帧序号
 * @property {number | null} vPendingPts
 * @property {number} vLastDur
 * @property {number[]} aSizes
 * @property {number[]} aOffs
 * @property {RleEntry[]} aRLE
 * @property {number | null} aPendingPts
 * @property {number} mdatPayload 已写 mdat 负载字节
 * @property {boolean} seenAudio
 * @property {number} lastAuPts 视频末样本 pts（续传后 wrap 调整基线）
 * @property {number} lastFramePts 音频末样本 pts
 */

export const TsRemux = (function () {
'use strict';

/** mdat 在 largesize 模式下的头长：size(4)=1 + 'mdat'(4) + largesize(8) */
const MDAT_HEADER = 16;
/** AV 交织冲刷窗口（90kHz，2 秒） */
const INTERLEAVE_WINDOW = 180000;

/**
 * @param {Uint8Array[]} parts
 * @returns {Uint8Array}
 */
function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/**
 * @param {number} n
 * @returns {Uint8Array}
 */
function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}

/**
 * @param {number} n
 * @returns {Uint8Array}
 */
function u16(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff);
  return b;
}

/**
 * @param {string} type 4 字符 box 类型
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
function box(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(payload, 8);
  return out;
}

/**
 * @param {string} type
 * @param {number} ver
 * @param {number} flags
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
function fullBox(type, ver, flags, payload) {
  const head = new Uint8Array(4);
  head[0] = ver;
  head[1] = (flags >> 16) & 255;
  head[2] = (flags >> 8) & 255;
  head[3] = flags & 255;
  return box(type, concat([head, payload]));
}

/**
 * MPEG-TS 嗅探：前 10 个包中 ≥80% 以 0x47 开头。
 * @param {Uint8Array | null | undefined} buf
 * @returns {boolean}
 */
function isMpegTs(buf) {
  if (!buf || buf.length < 188) return false;
  let hits = 0, n = 0;
  for (let i = 0; i + 188 <= Math.min(buf.length, 188 * 10); i += 188) {
    n++;
    if (buf[i] === 0x47) hits++;
  }
  return n > 0 && hits / n >= 0.8;
}

class Bits {
  /** @param {Uint8Array} u8 */
  constructor(u8) { this.d = u8; this.p = 0; }
  /**
   * 读 n 位无符号整数。
   * @param {number} n
   * @returns {number}
   */
  u(n) {
    let v = 0;
    while (n--) {
      const bi = this.p >> 3, bo = 7 - (this.p & 7);
      v = (v << 1) | ((this.d[bi] >> bo) & 1);
      this.p++;
    }
    return v;
  }
  /** 读 ue(v) 哥伦布编码。 @returns {number} */
  ue() {
    let z = 0;
    while (this.u(1) === 0) z++;
    return z ? ((1 << z) - 1) + this.u(z) : 0;
  }
  /** 读 se(v) 哥伦布编码。 @returns {number} */
  se() {
    const v = this.ue();
    return (v & 1) ? (v + 1) >> 1 : -(v >> 1);
  }
}

/**
 * 从 SPS NAL 解析分辨率与 profile。
 * @param {Uint8Array} nal
 * @returns {{ width: number, height: number, profile: number }}
 */
function parseSps(nal) {
  const r = new Bits(nal);
  r.u(8);
  const profile = r.u(8);
  r.u(8);
  r.u(8);
  r.ue();
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].indexOf(profile) >= 0) {
    const chroma = r.ue();
    if (chroma === 3) r.u(1);
    r.ue();
    r.ue();
    r.u(1);
    if (r.u(1)) return { width: 0, height: 0, profile };
  }
  r.ue();
  const poc = r.ue();
  if (poc === 0) r.ue();
  else if (poc === 1) {
    r.u(1); r.se(); r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue();
  r.u(1);
  const wM1 = r.ue();
  const hM1 = r.ue();
  const frameMbsOnly = r.u(1);
  if (!frameMbsOnly) r.u(1);
  r.u(1);
  let cL = 0, cR = 0, cT = 0, cB = 0;
  if (r.u(1)) { cL = r.ue(); cR = r.ue(); cT = r.ue(); cB = r.ue(); }
  return {
    width: (wM1 + 1) * 16 - (cL + cR) * 2,
    height: (2 - frameMbsOnly) * (hM1 + 1) * 16 - (cT + cB) * 2,
    profile,
  };
}

/**
 * 按 Annex-B 起始码切分 NAL 单元。
 * @param {Uint8Array} data
 * @returns {Uint8Array[]}
 */
function splitNals(data) {
  /** @type {Uint8Array[]} */
  const nals = [];
  const find = (/** @type {number} */ from) => {
    for (let p = from; p + 3 < data.length; p++) {
      if (data[p] === 0 && data[p + 1] === 0) {
        if (data[p + 2] === 1) return p;
        if (p + 3 < data.length && data[p + 2] === 0 && data[p + 3] === 1) return p;
      }
    }
    return -1;
  };
  let start = find(0);
  while (start >= 0) {
    const sc = (data[start + 2] === 1) ? 3 : 4;
    const next = find(start + sc);
    const end = next < 0 ? data.length : next;
    let s = start + sc;
    while (s < end && data[s] === 0 && s + 1 === end) s++;
    if (end - (start + sc) > 0) nals.push(data.subarray(start + sc, end));
    start = next;
  }
  return nals;
}

/**
 * Annex-B NAL 列表转 AVCC（4 字节大端长度前缀）。
 * @param {Uint8Array[]} nals
 * @returns {Uint8Array}
 */
function nalsToAvcc(nals) {
  /** @type {Uint8Array[]} */
  const parts = [];
  for (const nal of nals) {
    parts.push(u32(nal.length), nal);
  }
  return concat(parts);
}

/**
 * 33 位 PTS：首项必须用乘法而非 <<29——JS 位运算是 32 位有符号，
 * PTS ≥ 2^31（90kHz 下约 6.4 小时，或源流自带大初始偏移）会溢出成负数。
 * @param {Uint8Array} d
 * @param {number} off
 * @returns {number}
 */
function parsePts(d, off) {
  return (d[off] & 0x0e) * 536870912 +
    ((d[off + 1] & 0xff) << 22) +
    ((d[off + 2] & 0xfe) << 14) +
    ((d[off + 3] & 0xff) << 7) +
    ((d[off + 4] & 0xfe) >> 1);
}

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/**
 * TS 解复用：分离出 AVC 视频样本与 AAC 音频样本及流元数据。
 * @param {Uint8Array} ts
 * @returns {Demuxed}
 */
function demuxTs(ts) {
  /** @type {Record<string, { sid: number, pts: number | null, payload: Uint8Array } | null>} */
  const pesAcc = {};
  /** @type {Record<string, PesStream>} */
  const es = {};

  const finishPes = (/** @type {string} */ pid) => {
    const acc = pesAcc[pid];
    if (!acc || !acc.payload.length) return;
    const sid = acc.sid;
    const stream = es[pid] || (es[pid] = { sid, chunks: [], len: 0, ptsAt: [] });
    stream.sid = sid;
    if (acc.pts != null) stream.ptsAt.push({ off: stream.len, pts: acc.pts });
    stream.chunks.push(acc.payload);
    stream.len += acc.payload.length;
    pesAcc[pid] = null;
  };

  const pushPes = (/** @type {number} */ pid, /** @type {Uint8Array} */ payload, /** @type {boolean} */ pusi) => {
    if (pusi) {
      finishPes(String(pid));
      if (payload.length < 9 || payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) return;
      const sid = payload[3];
      const hlen = payload[8];
      const flags = payload[7];
      let pts = null;
      if (flags & 0x80) pts = parsePts(payload, 9);
      pesAcc[pid] = { sid, pts, payload: payload.subarray(9 + hlen) };
    } else if (pesAcc[pid]) {
      const a = pesAcc[pid].payload;
      const n = new Uint8Array(a.length + payload.length);
      n.set(a);
      n.set(payload, a.length);
      pesAcc[pid].payload = n;
    }
  };

  let i = 0;
  while (i < ts.length && ts[i] !== 0x47) i++;
  for (; i + 188 <= ts.length; i += 188) {
    if (ts[i] !== 0x47) {
      while (i < ts.length && ts[i] !== 0x47) i++;
      continue;
    }
    const pkt = ts.subarray(i, i + 188);
    const pusi = (pkt[1] & 0x40) !== 0;
    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
    if (pid === 0x1fff) continue;
    const afc = (pkt[3] >> 4) & 3;
    let off = 4;
    if (afc === 2 || afc === 3) off = 5 + pkt[4];
    if (off >= 188) continue;
    if (afc === 1 || afc === 3) pushPes(pid, pkt.subarray(off), pusi);
  }
  for (const pid of Object.keys(pesAcc)) finishPes(pid);

  /** @type {Uint8Array | undefined} */
  let sps;
  /** @type {Uint8Array | undefined} */
  let pps;
  let width = 0, height = 0, profile = 100;
  const level = 31;
  let sampleRate = 44100, channels = 2, aacProfile = 2;
  /** @type {VideoSample[]} */
  const video = [];
  /** @type {AudioSample[]} */
  const audio = [];

  const ptsFor = (/** @type {PesStream} */ stream, /** @type {number} */ off, /** @type {number} */ fallback) => {
    let pts = fallback;
    for (let k = 0; k < stream.ptsAt.length; k++) {
      if (stream.ptsAt[k].off <= off) pts = stream.ptsAt[k].pts;
      else break;
    }
    return pts;
  };

  for (const pid of Object.keys(es)) {
    const stream = es[pid];
    const data = concat(stream.chunks);
    if (stream.sid >= 0xe0 && stream.sid <= 0xef) {
      const nals = splitNals(data);
      /** @type {Uint8Array[]} */
      let group = [];
      let groupOff = 0;
      let lastPts = stream.ptsAt[0] ? stream.ptsAt[0].pts : 0;
      const flushAu = () => {
        const usable = group.filter((n) => {
          const t = n[0] & 0x1f;
          return t !== 7 && t !== 8 && t !== 9;
        });
        if (!usable.length) { group = []; return; }
        let pts = ptsFor(stream, groupOff, lastPts);
        if (pts < lastPts - 0x10000000) pts += 0x200000000;
        video.push({
          data: nalsToAvcc(usable),
          pts,
          isKey: usable.some((n) => (n[0] & 0x1f) === 5),
        });
        lastPts = pts;
        group = [];
      };
      let cursor = 0;
      for (const nal of nals) {
        const t = nal[0] & 0x1f;
        if (t === 7) {
          sps = new Uint8Array(nal);
          try {
            const info = parseSps(sps);
            if (info.width > 0) { width = info.width; height = info.height; profile = info.profile; }
          } catch {}
        } else if (t === 8) pps = new Uint8Array(nal);
        if (t === 9 || ((t === 1 || t === 5) && group.length && (group[0][0] & 0x1f) !== 9 && (nal[1] & 0x80))) {
          flushAu();
          groupOff = cursor;
        }
        group.push(nal);
        cursor += nal.length + 4;
      }
      flushAu();
    } else if (stream.sid >= 0xc0 && stream.sid <= 0xdf) {
      let p = 0;
      let lastA = stream.ptsAt[0] ? stream.ptsAt[0].pts : 0;
      while (p + 7 <= data.length) {
        if (data[p] !== 0xff || (data[p + 1] & 0xf0) !== 0xf0) { p++; continue; }
        const prot = data[p + 1] & 1;
        aacProfile = ((data[p + 2] >> 6) & 3) + 1;
        const sri = (data[p + 2] >> 2) & 0x0f;
        sampleRate = ADTS_RATES[sri] || sampleRate;
        channels = ((data[p + 2] & 1) << 2) | ((data[p + 3] >> 6) & 3);
        const len = ((data[p + 3] & 3) << 11) | (data[p + 4] << 3) | ((data[p + 5] >> 5) & 7);
        const hdr = prot ? 7 : 9;
        if (len < hdr || p + len > data.length) break;
        let pts = ptsFor(stream, p, lastA);
        if (pts < lastA - 0x10000000) pts += 0x200000000;
        audio.push({ data: new Uint8Array(data.subarray(p + hdr, p + len)), pts });
        lastA = pts;
        p += len;
      }
    }
  }

  return {
    video,
    audio,
    meta: { width: width || 1280, height: height || 720, profile: profile || 100, level: level || 31, sps, pps, sampleRate, channels, aacProfile },
  };
}

// ---------------------------------------------------------------------------
// 共享 MP4 构件（单遍与流式两条路径共用）
// ---------------------------------------------------------------------------

/** @returns {Uint8Array} ftyp（定长，流式路径的 stco 基准依赖其长度恒定） */
function ftypBox() {
  return box('ftyp', concat([
    new Uint8Array([0x69, 0x73, 0x6f, 0x6d]), u32(0x200),
    new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, 0x61, 0x76, 0x63, 0x31, 0x6d, 0x70, 0x34, 0x31]),
  ]));
}

/** @param {StreamMeta} meta @returns {Uint8Array} */
function avc1Box(meta) {
  const sps = /** @type {Uint8Array} */ (meta.sps);
  const pps = /** @type {Uint8Array} */ (meta.pps);
  const avcC = concat([
    new Uint8Array([1, sps[1], sps[2], sps[3], 0xff, 0xe1]),
    u16(sps.length), sps,
    new Uint8Array([1]),
    u16(pps.length), pps,
  ]);
  return box('avc1', concat([
    new Uint8Array(6), u16(1),
    new Uint8Array(16),
    u16(meta.width), u16(meta.height),
    new Uint8Array([0x00, 0x48, 0x00, 0x00, 0x00, 0x48, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]),
    new Uint8Array(32),
    new Uint8Array([0x00, 0x18, 0xff, 0xff]),
    box('avcC', avcC),
  ]));
}

/** @param {StreamMeta} meta @returns {Uint8Array} */
function mp4aBox(meta) {
  const aTimescale = meta.sampleRate || 44100;
  const freqIdx = Math.max(0, ADTS_RATES.indexOf(aTimescale));
  const asc = new Uint8Array(2);
  const obj = Math.min(meta.aacProfile, 4);
  asc[0] = (obj << 3) | ((freqIdx >> 1) & 7);
  asc[1] = ((freqIdx & 1) << 7) | ((meta.channels & 15) << 3);
  const esds = fullBox('esds', 0, 0, concat([
    new Uint8Array([0x03, 0x19, 0x00, 0x01, 0x00]),
    new Uint8Array([0x04, 0x11, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
    new Uint8Array([0x05, 0x02]), asc,
    new Uint8Array([0x06, 0x01, 0x02]),
  ]));
  return box('mp4a', concat([
    new Uint8Array(6), u16(1),
    new Uint8Array(8),
    u16(meta.channels), u16(16), new Uint8Array(4),
    u16(aTimescale), u16(0),
    esds,
  ]));
}

/** @param {RleEntry[]} entries @returns {Uint8Array} */
function sttsEntriesBox(entries) {
  /** @type {Uint8Array[]} */
  const body = [u32(entries.length)];
  for (const e of entries) body.push(u32(e.cnt), u32(e.dur));
  return fullBox('stts', 0, 0, concat(body));
}

/** @param {CttsEntry[]} entries @returns {Uint8Array} */
function cttsEntriesBox(entries) {
  /** @type {Uint8Array[]} */
  const body = [u32(entries.length)];
  for (const e of entries) body.push(u32(e.cnt), u32(e.off));
  return fullBox('ctts', 0, 0, concat(body));
}

/**
 * B 帧流视频时间轴构造（解码序 PTS 存在负差时启用）。
 * TS PES 只有 PTS：后向 min 构造原始 DTS（逐样本间距 ≥ tick），前向钳位（首样本贴 0、
 * 严格递增、≤pts），stts 写 DTS 差分、ctts 写 pts−dts 合成偏移（全 0 由调用方省 box）。
 * PTS 保持原值 → 音画同步零改动；首段 DTS 为负时贴地，差值被 ctts 吸收（呈现时间不变）。
 * @param {number[]} pts 解码序样本 PTS
 * @returns {{ stts: RleEntry[], ctts: CttsEntry[] | null, duration: number }}
 */
function buildVideoTiming(pts) {
  const n = pts.length;
  // 帧距估计：解码序正差是「帧距的 k 倍」（B 帧数可变），须取呈现序（PTS 升序）相邻差的中位数
  const sorted = pts.slice().sort((a, b) => a - b);
  /** @type {number[]} */
  const spans = [];
  for (let i = 1; i < n; i++) {
    const d = sorted[i] - sorted[i - 1];
    if (d > 0) spans.push(d);
  }
  spans.sort((a, b) => a - b);
  const tick = spans.length ? spans[Math.floor(spans.length / 2)] : Math.round(90000 / 30);
  // 后向构造：保证 DTS 逐样本间距 ≥ tick 且 ≤ pts
  const raw = new Array(n);
  raw[n - 1] = pts[n - 1];
  for (let i = n - 2; i >= 0; i--) raw[i] = Math.min(pts[i], raw[i + 1] - tick);
  // 前向钳位：首样本 ≥0、严格递增；病态流宁可局部间距 <tick 也不产生负 ctts
  /** @type {number[]} */
  const dts = new Array(n);
  for (let i = 0; i < n; i++) {
    let d = raw[i] > pts[i] ? pts[i] : raw[i];
    if (i === 0 ? d < 0 : d <= dts[i - 1]) d = i === 0 ? 0 : dts[i - 1] + 1;
    if (d > pts[i]) d = pts[i];
    dts[i] = d;
  }
  /** @type {RleEntry[]} */
  const stts = [];
  const pushStts = (/** @type {number} */ dur) => {
    if (stts.length && stts[stts.length - 1].dur === dur) stts[stts.length - 1].cnt++;
    else stts.push({ cnt: 1, dur });
  };
  for (let i = 1; i < n; i++) pushStts(Math.max(1, dts[i] - dts[i - 1]));
  pushStts(tick); // 末样本时长
  /** @type {CttsEntry[]} */
  const ctts = [];
  let allZero = true;
  for (let i = 0; i < n; i++) {
    const off = Math.max(0, pts[i] - dts[i]);
    if (ctts.length && ctts[ctts.length - 1].off === off) ctts[ctts.length - 1].cnt++;
    else ctts.push({ cnt: 1, off });
    if (off > 0) allZero = false;
  }
  return { stts, ctts: allZero ? null : ctts, duration: dts[n - 1] + tick };
}

/**
 * @param {Object} p
 * @param {number} p.id
 * @param {boolean} p.isVideo
 * @param {StreamMeta} p.meta
 * @param {number} p.timescale
 * @param {number} p.tkhdDur
 * @param {number} p.mdhdDur
 * @param {RleEntry[]} p.sttsEntries
 * @param {CttsEntry[] | null} [p.cttsEntries] 合成偏移（B 帧流）；null/空则省 ctts box
 * @param {number[] | null} p.keys 视频关键帧（1-based）；空则兜底 [1]
 * @param {number[]} p.sizes
 * @param {number[]} p.stco 最终绝对偏移（单遍路径传相对值，由 patchStco 补齐）
 * @returns {Uint8Array}
 */
function trakBox(p) {
  const { meta, isVideo } = p;
  const tkhd = fullBox('tkhd', 0, 3, concat([
    u32(0), u32(0), u32(p.id), u32(0), u32(p.tkhdDur),
    new Uint8Array(8), u16(0), u16(0), u16(0), u16(0),
    new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0]),
    u32(isVideo ? meta.width << 16 : 0), u32(isVideo ? meta.height << 16 : 0),
  ]));
  const mdhd = fullBox('mdhd', 0, 0, concat([
    u32(0), u32(0), u32(p.timescale), u32(p.mdhdDur),
    u16(0x55c4), u16(0),
  ]));
  const hdlr = fullBox('hdlr', 0, 0, concat([
    u32(0),
    new Uint8Array([isVideo ? 0x76 : 0x73, isVideo ? 0x69 : 0x6f, isVideo ? 0x64 : 0x75, isVideo ? 0x65 : 0x6e]),
    new Uint8Array(12),
    new Uint8Array(isVideo ? [0x56, 0x69, 0x64, 0x65, 0x6f, 0x48, 0x61, 0x6e, 0x64, 0x6c, 0x65, 0x72, 0] : [0x53, 0x6f, 0x75, 0x6e, 0x64, 0x48, 0x61, 0x6e, 0x64, 0x6c, 0x65, 0x72, 0]),
  ]));
  const mediaHead = isVideo ? box('vmhd', new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0])) : box('smhd', new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0]));
  const dinf = box('dinf', box('dref', concat([new Uint8Array([0, 0, 0, 0]), u32(1), fullBox('url ', 0, 1, new Uint8Array(0))])));
  const stsd = fullBox('stsd', 0, 0, concat([u32(1), isVideo ? avc1Box(meta) : mp4aBox(meta)]));
  const sttsBox = sttsEntriesBox(p.sttsEntries);
  const cttsBox = p.cttsEntries && p.cttsEntries.length ? cttsEntriesBox(p.cttsEntries) : new Uint8Array(0);
  /** @type {Uint8Array} */
  let stssBox = new Uint8Array(0);
  if (isVideo) {
    const keys = p.keys && p.keys.length ? p.keys : [1];
    /** @type {Uint8Array[]} */
    const body = [u32(keys.length)];
    for (const k of keys) body.push(u32(k));
    stssBox = fullBox('stss', 0, 0, concat(body));
  }
  const stsc = fullBox('stsc', 0, 0, concat([u32(1), u32(1), u32(1), u32(1)]));
  /** @type {Uint8Array[]} */
  const sz = [u32(0), u32(p.sizes.length)];
  for (const s of p.sizes) sz.push(u32(s));
  const stsz = fullBox('stsz', 0, 0, concat(sz));
  // stco 偏移为 u32：>4GB 会溢出。流式路径已无 1.5GB 护栏——超大文件依赖
  // 单文件 <4GB 的前提（真实片源远低于此）；若未来需要，改 co64。
  /** @type {Uint8Array[]} */
  const co = [u32(p.stco.length)];
  for (const o of p.stco) co.push(u32(o));
  const stco = fullBox('stco', 0, 0, concat(co));
  const stbl = box('stbl', concat([stsd, sttsBox, cttsBox, stssBox, stsc, stsz, stco].filter((x) => x.length)));
  const minf = box('minf', concat([mediaHead, dinf, stbl]));
  const mdia = box('mdia', concat([mdhd, hdlr, minf]));
  return box('trak', concat([tkhd, mdia]));
}

/**
 * @param {number} timescale
 * @param {number} duration
 * @param {number} nextTrackId
 * @returns {Uint8Array}
 */
function mvhdBox(timescale, duration, nextTrackId) {
  return fullBox('mvhd', 0, 0, concat([
    u32(0), u32(0), u32(timescale), u32(duration),
    u32(0x00010000), u16(0x0100), u16(0), new Uint8Array(8),
    new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0]),
    new Uint8Array(24), u32(nextTrackId),
  ]));
}

/**
 * 复用为扁平 MP4（ftyp + moov + mdat）。
 * @param {Demuxed} demuxed
 * @returns {Uint8Array}
 */
function muxMp4(demuxed) {
  const { video, audio, meta } = demuxed;
  if (!video.length) throw new Error('没有视频帧');
  if (!meta.sps || !meta.pps) throw new Error('缺少 SPS/PPS');

  const vTimescale = 90000;
  const aTimescale = meta.sampleRate || 44100;

  // B 帧检出（解码序 PTS 负差）：重构 DTS/ctts 时间轴；无 B 帧走原逻辑（行为不变）
  /** @type {number[]} */
  const vPtsList = video.map((s) => s.pts);
  const hasReorder = vPtsList.some((p, i) => i > 0 && p < vPtsList[i - 1]);
  /** @type {RleEntry[]} */
  let vEntries;
  /** @type {CttsEntry[] | null} */
  let vCtts = null;
  let vDuration = 0;
  /** @type {number[]} */
  const vDurs = [];
  if (hasReorder) {
    const t = buildVideoTiming(vPtsList);
    vEntries = t.stts;
    vCtts = t.ctts;
    vDuration = t.duration;
  } else {
    for (let i = 0; i < video.length; i++) {
      if (i + 1 < video.length) vDurs.push(Math.max(1, video[i + 1].pts - video[i].pts));
    }
    const vFallback = vDurs.length ? vDurs[vDurs.length - 1] : Math.round(vTimescale / 30);
    if (vDurs.length < video.length) vDurs.push(vFallback);
    vDuration = vDurs.reduce((a, b) => a + b, 0);
    // CBR 重写仅用于旧时间轴路径（新构造保证时基正确，无需）
    if (audio.length) {
      const aTicks = Math.round(audio.length * 1024 * vTimescale / aTimescale);
      if (aTicks > 0 && (vDuration > aTicks * 1.12 || vDuration < aTicks * 0.75)) {
        const tick = Math.max(1, Math.round(aTicks / video.length));
        vDuration = tick * video.length;
        vDurs.length = 0;
        for (let i = 0; i < video.length; i++) vDurs.push(tick);
      }
    }
    vEntries = [];
    for (const d of vDurs) {
      if (vEntries.length && vEntries[vEntries.length - 1].dur === d) vEntries[vEntries.length - 1].cnt++;
      else vEntries.push({ cnt: 1, dur: d });
    }
  }

  const aFrameDur = Math.round(1024 * 90000 / aTimescale);
  /** @type {number[]} */
  const aDurs = [];
  for (let i = 0; i < audio.length; i++) {
    if (i + 1 < audio.length) aDurs.push(Math.max(1, audio[i + 1].pts - audio[i].pts));
    else aDurs.push(aFrameDur);
  }
  const aDuration = aDurs.reduce((a, b) => a + b, 0);
  const duration = Math.max(vDuration, aDuration);

  /** @type {number[]} */
  const vKeys = [];
  for (let i = 0; i < video.length; i++) if (video[i].isKey) vKeys.push(i + 1);

  /** @type {Uint8Array[]} */
  const mdats = [];
  /** @type {number[]} */
  const vOff = [];
  /** @type {number[]} */
  const aOff = [];
  let cursor = 0;
  let vi = 0, ai = 0;
  while (vi < video.length || ai < audio.length) {
    const takeA = ai < audio.length && (vi >= video.length || audio[ai].pts <= video[vi].pts);
    if (takeA) {
      aOff.push(cursor);
      mdats.push(audio[ai].data);
      cursor += audio[ai].data.length;
      ai++;
    } else {
      vOff.push(cursor);
      mdats.push(video[vi].data);
      cursor += video[vi].data.length;
      vi++;
    }
  }
  const mdatPayload = concat(mdats);

  const moov = box('moov', concat([
    mvhdBox(vTimescale, duration, audio.length ? 3 : 2),
    trakBox({
      id: 1, isVideo: true, meta, timescale: vTimescale,
      tkhdDur: vDuration, mdhdDur: vDuration,
      sttsEntries: vEntries, cttsEntries: vCtts, keys: vKeys,
      sizes: video.map((s) => s.data.length), stco: vOff,
    }),
    ...(audio.length ? [trakBox({
      id: 2, isVideo: false, meta, timescale: aTimescale,
      tkhdDur: aDuration, mdhdDur: audio.length * 1024,
      sttsEntries: [{ cnt: audio.length, dur: 1024 }], keys: null,
      sizes: audio.map((s) => s.data.length), stco: aOff,
    })] : []),
  ]));
  const ftyp = ftypBox();

  const mdatHead = 8;
  const mdatOffset = ftyp.length + moov.length + mdatHead;
  /** @param {Uint8Array} mp4 */
  function patchStco(mp4) {
    const view = new DataView(mp4.buffer, mp4.byteOffset, mp4.byteLength);
    const walk = (/** @type {number} */ start, /** @type {number} */ end) => {
      let off = start;
      while (off + 8 <= end) {
        const size = view.getUint32(off);
        if (size < 8 || off + size > end) break;
        const typ = String.fromCharCode(mp4[off + 4], mp4[off + 5], mp4[off + 6], mp4[off + 7]);
        if (typ === 'stco') {
          const count = view.getUint32(off + 12);
          for (let i = 0; i < count; i++) {
            const cur = view.getUint32(off + 16 + i * 4);
            view.setUint32(off + 16 + i * 4, cur + mdatOffset);
          }
        } else if (typ === 'moov' || typ === 'trak' || typ === 'mdia' || typ === 'minf' || typ === 'stbl') {
          walk(off + 8, off + size);
        }
        off += size;
      }
    };
    walk(0, mp4.length);
  }

  const mdat = box('mdat', mdatPayload);
  const mp4 = concat([ftyp, moov, mdat]);
  patchStco(mp4);
  return mp4;
}

/**
 * 入口：TS（或分段数组）→ MP4；非 TS 输入原样返回。
 * @param {Uint8Array[] | Uint8Array | ArrayBuffer} chunksOrTs
 * @returns {Uint8Array}
 */
function remux(chunksOrTs) {
  /** @type {Uint8Array} */
  let ts;
  if (Array.isArray(chunksOrTs)) ts = concat(chunksOrTs);
  else ts = chunksOrTs instanceof Uint8Array ? chunksOrTs : new Uint8Array(chunksOrTs);
  if (!isMpegTs(ts)) return ts;
  return muxMp4(demuxTs(ts));
}

// ---------------------------------------------------------------------------
// 流式 remux
// ---------------------------------------------------------------------------

/**
 * @param {Uint8Array} u8
 * @returns {string}
 */
function u8ToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

/**
 * @param {string} s
 * @returns {Uint8Array}
 */
function b64ToU8(s) {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

/**
 * @param {{ off: number, pts: number }[]} ptsAt
 * @param {number} off
 * @param {number} fallback
 * @returns {number}
 */
function ptsAtLookup(ptsAt, off, fallback) {
  let pts = fallback;
  for (let k = 0; k < ptsAt.length; k++) {
    if (ptsAt[k].off <= off) pts = ptsAt[k].pts;
    else break;
  }
  return pts;
}

/**
 * 裁剪 ptsAt：保留最后一个 ≤ base 的条目作为回退，丢弃更早的。
 * @param {{ off: number, pts: number }[]} ptsAt
 * @param {number} base
 * @returns {{ off: number, pts: number }[]}
 */
function prunePtsAt(ptsAt, base) {
  let keep = -1;
  for (let k = 0; k < ptsAt.length; k++) {
    if (ptsAt[k].off <= base) keep = k;
    else break;
  }
  return keep > 0 ? ptsAt.slice(keep) : ptsAt;
}

/**
 * @typedef {Object} VidState
 * @property {Uint8Array} es 未消费 ES 字节（自最后一个完整 NAL 起）
 * @property {number} esBase es 在整条流中的起始偏移
 * @property {{ off: number, pts: number }[]} ptsAt
 * @property {Uint8Array[]} group 当前 AU 的 NAL 组
 * @property {number} groupPts
 * @property {number} lastAuPts
 */

/**
 * @typedef {Object} AudState
 * @property {Uint8Array} es 未消费 ES 字节
 * @property {number} esBase
 * @property {{ off: number, pts: number }[]} ptsAt
 * @property {number} lastPts
 */

/**
 * 流式 remux 会话。
 * @param {RemuxSnapshot | null} [snapshot] 续传恢复快照（分段边界，demux 状态全新）
 * @returns {StreamingRemuxSession} 会话
 */
function createStreamingRemux(snapshot) {
  /** @type {Uint8Array} */
  let rest = new Uint8Array(0);
  /** @type {Record<string, { sid: number, pts: number | null, payload: Uint8Array } | null>} */
  const pesAcc = {};
  /** @type {Record<string, VidState>} */
  const vids = {};
  /** @type {Record<string, AudState>} */
  const auds = {};
  /** @type {VideoSample[]} */
  const outV = [];
  /** @type {AudioSample[]} */
  const outA = [];
  /** @type {number | null} */
  let lastVpts = null;
  /** @type {number | null} */
  let lastApts = null;
  let seenAudio = false;
  /** @type {StreamMeta} */
  const meta = { width: 0, height: 0, profile: 100, level: 31, sps: undefined, pps: undefined, sampleRate: 44100, channels: 2, aacProfile: 2 };
  // mux 元数据（快照持久化的全部状态）
  /** @type {number[]} */ const vSizes = [];
  /** @type {number[]} */ const vOffs = [];
  /** @type {RleEntry[]} */ const vRLE = [];
  /** @type {number[]} */ const vPts = [];
  /** @type {number[]} */ const vKeys = [];
  /** @type {number | null} */ let vPendingPts = null;
  let vLastDur = 0;
  /** @type {number[]} */ const aSizes = [];
  /** @type {number[]} */ const aOffs = [];
  /** @type {RleEntry[]} */ const aRLE = [];
  /** @type {number | null} */ let aPendingPts = null;
  let mdatPayload = 0;
  // 续传种子：新建 demux 状态的 pts 基线
  let seedVpts = 0;
  let seedApts = 0;

  if (snapshot) {
    meta.width = snapshot.width; meta.height = snapshot.height;
    meta.profile = snapshot.profile; meta.level = snapshot.level;
    meta.sampleRate = snapshot.sampleRate; meta.channels = snapshot.channels;
    meta.aacProfile = snapshot.aacProfile;
    meta.sps = snapshot.sps ? b64ToU8(snapshot.sps) : undefined;
    meta.pps = snapshot.pps ? b64ToU8(snapshot.pps) : undefined;
    vSizes.push(...snapshot.vSizes); vOffs.push(...snapshot.vOffs);
    for (const e of snapshot.vRLE) vRLE.push({ cnt: e.cnt, dur: e.dur });
    if (Array.isArray(snapshot.vPts)) vPts.push(...snapshot.vPts);
    vKeys.push(...snapshot.vKeys);
    vPendingPts = snapshot.vPendingPts; vLastDur = snapshot.vLastDur;
    aSizes.push(...snapshot.aSizes); aOffs.push(...snapshot.aOffs);
    for (const e of snapshot.aRLE) aRLE.push({ cnt: e.cnt, dur: e.dur });
    aPendingPts = snapshot.aPendingPts;
    mdatPayload = snapshot.mdatPayload;
    seenAudio = snapshot.seenAudio;
    seedVpts = snapshot.lastAuPts; seedApts = snapshot.lastFramePts;
    lastVpts = snapshot.vPendingPts; lastApts = snapshot.aPendingPts;
  }

  /**
   * @param {RleEntry[]} rle
   * @param {number} dur
   */
  function pushRle(rle, dur) {
    if (rle.length && rle[rle.length - 1].dur === dur) rle[rle.length - 1].cnt++;
    else rle.push({ cnt: 1, dur });
  }

  /** @param {VidState} V */
  function flushAu(V) {
    const usable = V.group.filter((n) => {
      const t = n[0] & 0x1f;
      return t !== 7 && t !== 8 && t !== 9;
    });
    V.group = [];
    if (!usable.length) return;
    let pts = V.groupPts;
    if (pts < V.lastAuPts - 0x10000000) pts += 0x200000000;
    V.lastAuPts = pts;
    lastVpts = pts;
    outV.push({
      data: nalsToAvcc(usable),
      pts,
      isKey: usable.some((n) => (n[0] & 0x1f) === 5),
    });
  }

  /**
   * @param {VidState} V
   * @param {Uint8Array} nal
   * @param {number} absOff NAL 在整条 ES 中的偏移
   */
  function consumeVideoNal(V, nal, absOff) {
    const t = nal[0] & 0x1f;
    if (t === 7) {
      meta.sps = new Uint8Array(nal);
      try {
        const info = parseSps(meta.sps);
        if (info.width > 0) { meta.width = info.width; meta.height = info.height; meta.profile = info.profile; }
      } catch {}
    } else if (t === 8) {
      meta.pps = new Uint8Array(nal);
    }
    if (t === 9 || ((t === 1 || t === 5) && V.group.length && (V.group[0][0] & 0x1f) !== 9 && (nal[1] & 0x80))) {
      flushAu(V);
    }
    if (!V.group.length) V.groupPts = ptsAtLookup(V.ptsAt, absOff, V.lastAuPts);
    V.group.push(nal);
  }

  /**
   * 从 V.es 提取完整 NAL（看到下一个起始码才算完整）；残余保留。
   * @param {VidState} V
   * @param {boolean} flush true 时末尾残余也按 NAL 消费
   */
  function extractVideoNals(V, flush) {
    const d = V.es;
    const find = (/** @type {number} */ from) => {
      for (let p = from; p + 3 < d.length; p++) {
        if (d[p] === 0 && d[p + 1] === 0) {
          if (d[p + 2] === 1) return p;
          if (p + 3 < d.length && d[p + 2] === 0 && d[p + 3] === 1) return p;
        }
      }
      return -1;
    };
    let start = find(0);
    /** 已确认可丢弃的字节数（保留可能跨边界的起始码残余） */
    let consumed = 0;
    while (start >= 0) {
      const sc = d[start + 2] === 1 ? 3 : 4;
      const next = find(start + sc);
      if (next < 0 && !flush) { consumed = start; break; }
      const end = next < 0 ? d.length : next;
      if (end - (start + sc) > 0) consumeVideoNal(V, d.subarray(start + sc, end), V.esBase + start);
      consumed = end;
      if (next < 0) break;
      start = next;
    }
    if (start < 0) consumed = Math.max(0, d.length - 3); // 保留可能跨边界的起始码
    if (consumed > 0) {
      V.es = d.subarray(consumed);
      V.esBase += consumed;
      V.ptsAt = prunePtsAt(V.ptsAt, V.esBase);
    }
  }

  /**
   * @param {VidState} V
   * @param {Uint8Array} payload
   * @param {number | null} pts
   */
  function feedVideo(V, payload, pts) {
    if (pts != null) V.ptsAt.push({ off: V.esBase + V.es.length, pts });
    const nes = new Uint8Array(V.es.length + payload.length);
    nes.set(V.es);
    nes.set(payload, V.es.length);
    V.es = nes;
    extractVideoNals(V, false);
  }

  /**
   * @param {AudState} A
   * @param {boolean} _flush 末尾不完整帧直接丢弃（与单遍一致）
   */
  function parseAudio(A, _flush) {
    const d = A.es;
    let p = 0;
    while (p + 7 <= d.length) {
      if (d[p] !== 0xff || (d[p + 1] & 0xf0) !== 0xf0) { p++; continue; }
      const prot = d[p + 1] & 1;
      meta.aacProfile = ((d[p + 2] >> 6) & 3) + 1;
      const sri = (d[p + 2] >> 2) & 0x0f;
      meta.sampleRate = ADTS_RATES[sri] || meta.sampleRate;
      meta.channels = ((d[p + 2] & 1) << 2) | ((d[p + 3] >> 6) & 3);
      const len = ((d[p + 3] & 3) << 11) | (d[p + 4] << 3) | ((d[p + 5] >> 5) & 7);
      const hdr = prot ? 7 : 9;
      if (len < hdr) break;
      if (p + len > d.length) break; // 不完整，等下次
      let pts = ptsAtLookup(A.ptsAt, A.esBase + p, A.lastPts);
      if (pts < A.lastPts - 0x10000000) pts += 0x200000000;
      A.lastPts = pts;
      lastApts = pts;
      seenAudio = true;
      outA.push({ data: new Uint8Array(d.subarray(p + hdr, p + len)), pts });
      p += len;
    }
    if (p > 0) {
      A.es = d.subarray(p);
      A.esBase += p;
      A.ptsAt = prunePtsAt(A.ptsAt, A.esBase);
    }
  }

  /**
   * @param {AudState} A
   * @param {Uint8Array} payload
   * @param {number | null} pts
   */
  function feedAudio(A, payload, pts) {
    if (pts != null) A.ptsAt.push({ off: A.esBase + A.es.length, pts });
    const nes = new Uint8Array(A.es.length + payload.length);
    nes.set(A.es);
    nes.set(payload, A.es.length);
    A.es = nes;
    parseAudio(A, false);
  }

  /** @param {string} pid */
  function finishPes(pid) {
    const acc = pesAcc[pid];
    if (!acc || !acc.payload.length) return;
    pesAcc[pid] = null;
    if (acc.sid >= 0xe0 && acc.sid <= 0xef) {
      const V = vids[pid] || (vids[pid] = { es: new Uint8Array(0), esBase: 0, ptsAt: [], group: [], groupPts: seedVpts, lastAuPts: seedVpts });
      feedVideo(V, acc.payload, acc.pts);
    } else if (acc.sid >= 0xc0 && acc.sid <= 0xdf) {
      const A = auds[pid] || (auds[pid] = { es: new Uint8Array(0), esBase: 0, ptsAt: [], lastPts: seedApts });
      feedAudio(A, acc.payload, acc.pts);
    }
  }

  /**
   * @param {number} pid
   * @param {Uint8Array} payload
   * @param {boolean} pusi
   */
  function pushPes(pid, payload, pusi) {
    if (pusi) {
      finishPes(String(pid));
      if (payload.length < 9 || payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) return;
      const sid = payload[3];
      const hlen = payload[8];
      const flags = payload[7];
      let pts = null;
      if (flags & 0x80) pts = parsePts(payload, 9);
      pesAcc[pid] = { sid, pts, payload: payload.subarray(9 + hlen) };
    } else if (pesAcc[pid]) {
      const a = pesAcc[pid].payload;
      const n = new Uint8Array(a.length + payload.length);
      n.set(a);
      n.set(payload, a.length);
      pesAcc[pid].payload = n;
    }
  }

  /** @param {Uint8Array} pkt 188 字节 TS 包 */
  function feedPacket(pkt) {
    const pusi = (pkt[1] & 0x40) !== 0;
    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
    if (pid === 0x1fff) return;
    const afc = (pkt[3] >> 4) & 3;
    let off = 4;
    if (afc === 2 || afc === 3) off = 5 + pkt[4];
    if (off >= 188) return;
    if (afc === 1 || afc === 3) pushPes(pid, pkt.subarray(off), pusi);
  }

  /**
   * @param {'v' | 'a'} kind
   * @param {VideoSample | AudioSample} s
   */
  function emitSample(kind, s) {
    if (kind === 'v') {
      vOffs.push(mdatPayload);
      vSizes.push(s.data.length);
      vPts.push(s.pts);
      if (/** @type {VideoSample} */ (s).isKey) vKeys.push(vSizes.length);
      if (vPendingPts != null) {
        const d = Math.max(1, s.pts - vPendingPts);
        pushRle(vRLE, d);
        vLastDur = d;
      }
      vPendingPts = s.pts;
    } else {
      aOffs.push(mdatPayload);
      aSizes.push(s.data.length);
      if (aPendingPts != null) pushRle(aRLE, Math.max(1, s.pts - aPendingPts));
      aPendingPts = s.pts;
    }
    mdatPayload += s.data.length;
  }

  /**
   * 冲刷交织队列。
   * @param {boolean} force true 时清空（finalize）
   * @returns {Uint8Array[]} mdat 块
   */
  function drain(force) {
    /** @type {Uint8Array[]} */
    const chunks = [];
    while (outV.length || outA.length) {
      if (!force) {
        // 双轨：只冲刷两条轨都已覆盖的时间点之前的样本；单轨（纯视频）：按窗口
        if (seenAudio && !(outV.length && outA.length)) break;
        const lv = /** @type {number} */ (lastVpts);
        const la = /** @type {number} */ (lastApts);
        const cut = seenAudio ? Math.min(lv, la) : lv - INTERLEAVE_WINDOW;
        const headPts = !outV.length ? outA[0].pts : !outA.length ? outV[0].pts : Math.min(outV[0].pts, outA[0].pts);
        if (headPts > cut) break;
      }
      /** @type {'v' | 'a'} */
      let kind;
      if (!outV.length) kind = 'a';
      else if (!outA.length) kind = 'v';
      else kind = outA[0].pts <= outV[0].pts ? 'a' : 'v';
      const s = kind === 'v' ? /** @type {VideoSample} */ (outV.shift()) : /** @type {AudioSample} */ (outA.shift());
      emitSample(kind, s);
      chunks.push(s.data);
    }
    return chunks;
  }

  return {
    /** ftyp 常量（文件头，stco 基准） @returns {Uint8Array} */
    get ftyp() { return ftypBox(); },
    /** mdat 头长（largesize 模式） @returns {number} */
    get mdatHeaderSize() { return MDAT_HEADER; },
    /** 已写 mdat 负载字节 @returns {number} */
    get mdatPayload() { return mdatPayload; },
    /**
     * remux 可行性已验证（见到 H.264 SPS/PPS；HEVC 的 NAL 结构不会被误判为 SPS）。
     * 注意 PES/NAL 完整性有一拍滞后：通常在第二段推入后转真。
     * @returns {boolean}
     */
    get validated() { return !!(meta.sps && meta.pps); },

    /**
     * 推入一段解密后的 TS 字节，返回冲刷出的 mdat 块。
     * @param {Uint8Array} u8
     * @returns {Uint8Array[]}
     */
    push(u8) {
      const buf = rest.length ? concat([rest, u8]) : u8;
      let i = 0;
      while (i < buf.length && buf[i] !== 0x47) i++;
      while (i + 188 <= buf.length) {
        if (buf[i] !== 0x47) {
          i++;
          while (i < buf.length && buf[i] !== 0x47) i++;
          continue;
        }
        feedPacket(buf.subarray(i, i + 188));
        i += 188;
      }
      rest = buf.subarray(Math.min(i, buf.length));
      return drain(false);
    },

    /**
     * 收尾：冲刷残余样本并构建 moov（置尾）。
     * @returns {{ mdat: Uint8Array[], moov: Uint8Array, mdatPayload: number }}
     */
    finalize() {
      for (const pid of Object.keys(pesAcc)) finishPes(pid);
      for (const V of Object.values(vids)) { extractVideoNals(V, true); flushAu(V); }
      for (const A of Object.values(auds)) parseAudio(A, true);
      const mdat = drain(true);
      if (!vSizes.length) throw new Error('没有视频帧');
      if (!meta.sps || !meta.pps) throw new Error('缺少 SPS/PPS');

      // 末样本时长提交（与单遍同规则：视频取上一时长/默认 30fps，音频取帧长）
      if (vPendingPts != null) pushRle(vRLE, vLastDur || Math.round(90000 / 30));
      const aTimescale = meta.sampleRate || 44100;
      const aFrameDur = Math.round(1024 * 90000 / aTimescale);
      if (aPendingPts != null) pushRle(aRLE, aFrameDur);

      const vCount = vSizes.length;
      const aCount = aSizes.length;
      /** @param {RleEntry[]} rle @returns {number} */
      const sumRle = (rle) => rle.reduce((s, e) => s + e.cnt * e.dur, 0);
      let vEntries = vRLE;
      /** @type {CttsEntry[] | null} */
      let vCtts = null;
      let vDuration = sumRle(vRLE);
      // B 帧重排时间轴（vPts 完整 = 新版快照或本次会话全程）：stts=DTS 差分 + ctts 合成偏移；
      // 旧快照（无 vPts）或无 B 帧流回退旧逻辑（含 CBR 校正）
      const canRetime = vPts.length === vCount && vCount > 1 && vPts.some((p, i) => i > 0 && p < vPts[i - 1]);
      if (canRetime) {
        const t = buildVideoTiming(vPts);
        vEntries = t.stts;
        vCtts = t.ctts;
        vDuration = t.duration;
      } else if (aCount) {
        // 与单遍一致的视频时基校正（音频 tick 为基准重采样视频时长）
        const aTicks = Math.round(aCount * 1024 * 90000 / aTimescale);
        if (aTicks > 0 && (vDuration > aTicks * 1.12 || vDuration < aTicks * 0.75)) {
          const tick = Math.max(1, Math.round(aTicks / vCount));
          vEntries = [{ cnt: vCount, dur: tick }];
          vDuration = tick * vCount;
        }
      }
      const aDuration = sumRle(aRLE);
      const duration = Math.max(vDuration, aDuration);

      const ftyp = ftypBox();
      const base = ftyp.length + MDAT_HEADER;
      const effMeta = {
        ...meta,
        width: meta.width || 1280,
        height: meta.height || 720,
        profile: meta.profile || 100,
        level: meta.level || 31,
      };
      const moov = box('moov', concat([
        mvhdBox(90000, duration, aCount ? 3 : 2),
        trakBox({
          id: 1, isVideo: true, meta: effMeta, timescale: 90000,
          tkhdDur: vDuration, mdhdDur: vDuration,
          sttsEntries: vEntries, cttsEntries: vCtts, keys: vKeys,
          sizes: vSizes, stco: vOffs.map((o) => base + o),
        }),
        ...(aCount ? [trakBox({
          id: 2, isVideo: false, meta: effMeta, timescale: aTimescale,
          tkhdDur: aDuration, mdhdDur: aCount * 1024,
          sttsEntries: [{ cnt: aCount, dur: 1024 }], keys: null,
          sizes: aSizes, stco: aOffs.map((o) => base + o),
        })] : []),
      ]));
      return { mdat, moov, mdatPayload };
    },

    /**
     * 分段边界检查点：静默 demux（收尾进行中的 PES/AU）→ 冲刷交织队列 →
     * 重置 demux 状态（pts 基线留种）。HLS 分段为 AU/包边界，静默语义无损；
     * 返回的快照即可用于断点续传恢复（与继续运行本会话等价）。
     * @returns {{ mdat: Uint8Array[], snapshot: RemuxSnapshot }}
     */
    checkpoint() {
      for (const pid of Object.keys(pesAcc)) finishPes(pid);
      for (const V of Object.values(vids)) { extractVideoNals(V, true); flushAu(V); }
      for (const A of Object.values(auds)) parseAudio(A, true);
      const mdat = drain(true);
      // 重置 demux 状态（mux 元数据与 pts 种子保留）
      for (const pid of Object.keys(pesAcc)) pesAcc[pid] = null;
      for (const pid of Object.keys(vids)) delete vids[pid];
      for (const pid of Object.keys(auds)) delete auds[pid];
      rest = new Uint8Array(0);
      if (lastVpts != null) seedVpts = lastVpts;
      if (lastApts != null) seedApts = lastApts;
      const snapshot = {
        width: meta.width, height: meta.height, profile: meta.profile, level: meta.level,
        sampleRate: meta.sampleRate, channels: meta.channels, aacProfile: meta.aacProfile,
        sps: meta.sps ? u8ToB64(meta.sps) : '',
        pps: meta.pps ? u8ToB64(meta.pps) : '',
        vSizes: [...vSizes], vOffs: [...vOffs],
        vRLE: vRLE.map((e) => ({ cnt: e.cnt, dur: e.dur })),
        vPts: [...vPts],
        vKeys: [...vKeys], vPendingPts, vLastDur,
        aSizes: [...aSizes], aOffs: [...aOffs],
        aRLE: aRLE.map((e) => ({ cnt: e.cnt, dur: e.dur })),
        aPendingPts,
        mdatPayload,
        seenAudio,
        lastAuPts: lastVpts || 0,
        lastFramePts: lastApts || 0,
      };
      return { mdat, snapshot };
    },
  };
}

return { isMpegTs, remux, demuxTs, muxMp4, createStreamingRemux, MDAT_HEADER };
})();
