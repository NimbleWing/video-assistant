// ts-remux 测试夹具：合成 MPEG-TS 包 + 解析产物 MP4 的 box 树。

/**
 * 33 位 PTS 编码为 PES 头部的 5 字节。
 * 注意：必须用除法而非 >>> —— pts ≥ 2^32 时位运算会先截断为 32 位（与被测代码同款陷阱）。
 * @param {number} pts
 * @returns {number[]}
 */
export function encodePts(pts) {
  return [
    (0x2 << 4) | ((Math.floor(pts / 536870912) & 0x07) << 1) | 1,
    Math.floor(pts / 4194304) & 0xff,
    ((Math.floor(pts / 32768) & 0x7f) << 1) | 1,
    Math.floor(pts / 128) & 0xff,
    ((pts % 128) << 1) | 1,
  ];
}

/**
 * 打包一个 PES 为 188 字节 TS 包序列。
 * @param {number} pid
 * @param {number} sid PES stream_id（0xE0 视频 / 0xC0 音频）
 * @param {Uint8Array} payload ES 数据
 * @param {number | null} pts 90kHz；null 表示不带 PTS
 * @returns {Uint8Array}
 */
export function tsPackets(pid, sid, payload, pts) {
  const header = [0, 0, 1, sid];
  const pesLen = payload.length + (pts != null ? 13 : 8); // 可选头部字节 + 3 字节固定
  header.push((pesLen >> 8) & 0xff, pesLen & 0xff);
  if (pts != null) header.push(0x80, 0x80, 0x05, ...encodePts(pts));
  else header.push(0x80, 0x00, 0x00);
  const pes = new Uint8Array([...header, ...payload]);

  // 切分为 TS 包（首个包带 PUSI，末包 adaptation field  stuffing）
  /** @type {number[]} */
  const out = [];
  let off = 0;
  let first = true;
  while (off < pes.length) {
    const room = 184;
    const slice = pes.subarray(off, off + room);
    const pkt = new Array(188).fill(0xff);
    pkt[0] = 0x47;
    pkt[1] = ((first ? 0x40 : 0x00) | ((pid >> 8) & 0x1f));
    pkt[2] = pid & 0xff;
    const need = room - slice.length;
    if (need > 0) {
      // adaptation field 填充
      pkt[3] = 0x30; // adaptation + payload
      pkt[4] = need - 1;
      for (let i = 0; i < need - 1; i++) pkt[5 + i] = 0xff;
      const start = 4 + need;
      for (let i = 0; i < slice.length; i++) pkt[start + i] = slice[i];
    } else {
      pkt[3] = 0x10;
      for (let i = 0; i < slice.length; i++) pkt[4 + i] = slice[i];
    }
    out.push(...pkt);
    off += slice.length;
    first = false;
  }
  return new Uint8Array(out);
}

/** Annex-B 起始码包一个 NAL。 @param {number[]} nal @returns {number[]} */
export function annexB(nal) {
  return [0, 0, 1, ...nal];
}

/**
 * 哥伦布编码位写入器（用于手工构造 SPS）。
 * @returns {{ u(n: number, v: number): void, ue(v: number): void, se(v: number): void, bytes(): number[] }}
 */
export function bitWriter() {
  /** @type {number[]} */
  const bits = [];
  return {
    /** @param {number} n @param {number} v */
    u(n, v) { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); },
    /** @param {number} v */
    ue(v) {
      const codeNum = v + 1;
      const len = Math.floor(Math.log2(codeNum));
      for (let i = 0; i < len; i++) bits.push(0);
      for (let i = len; i >= 0; i--) bits.push((codeNum >> i) & 1);
    },
    /** @param {number} v */
    se(v) { this.ue(v <= 0 ? -2 * v : 2 * v - 1); },
    /** @returns {number[]} 末尾补 1 + 0 对齐 */
    bytes() {
      bits.push(1); // rbsp_stop_one_bit
      while (bits.length % 8) bits.push(0);
      /** @type {number[]} */
      const out = [];
      for (let i = 0; i < bits.length; i += 8) {
        let b = 0;
        for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
        out.push(b);
      }
      return out;
    },
  };
}

/**
 * 构造一个 High profile SPS NAL（0x67 头），指定宏块尺寸。
 * 注意：调用方需保证字节流不含 00 00 {00..03}（本工具生成的值域内不会触发 EPB）。
 * @param {number} wM1 pic_width_in_mbs_minus1
 * @param {number} hM1 pic_height_in_map_units_minus1
 * @returns {number[]}
 */
export function makeSps(wM1, hM1) {
  const w = bitWriter();
  w.u(8, 100); // profile_idc: High
  w.u(8, 0);   // constraint flags
  w.u(8, 31);  // level_idc
  w.ue(0);     // seq_parameter_set_id
  w.ue(1);     // chroma_format_idc = 4:2:0
  w.ue(0);     // bit_depth_luma_minus8
  w.ue(0);     // bit_depth_chroma_minus8
  w.u(1, 0);   // qpprime_y_zero_transform_bypass
  w.u(1, 0);   // seq_scaling_matrix_present
  w.ue(0);     // log2_max_frame_num_minus4
  w.ue(0);     // pic_order_cnt_type
  w.ue(0);     // log2_max_pic_order_cnt_lsb_minus4
  w.ue(0);     // max_num_ref_frames
  w.u(1, 0);   // gaps_in_frame_num_value_allowed
  w.ue(wM1);   // pic_width_in_mbs_minus1
  w.ue(hM1);   // pic_height_in_map_units_minus1
  w.u(1, 1);   // frame_mbs_only_flag
  w.u(1, 0);   // direct_8x8_inference_flag
  w.u(1, 0);   // frame_cropping_flag
  return [0x67, ...w.bytes()];
}

/**
 * 解析 MP4 box 树（按路径取首个匹配，如 'moov/trak/mdia/hdlr'）。
 * @param {Uint8Array} mp4
 * @param {string} path 以 / 分隔；trak 取第 n 个用 trak[0]/trak[1]
 * @returns {{ off: number, size: number, type: string, body: Uint8Array } | null}
 */
export function findBox(mp4, path) {
  const parts = path.split('/');
  let start = 0;
  let end = mp4.length;
  /** @type {{ off: number, size: number, type: string, body: Uint8Array } | null} */
  let found = null;
  for (const raw of parts) {
    const m = raw.match(/^([a-z0-9 ]{4})(?:\[(\d+)\])?$/i);
    if (!m) return null;
    const want = m[1];
    const wantIdx = m[2] ? Number(m[2]) : 0;
    let idx = 0;
    let off = start;
    found = null;
    while (off + 8 <= end) {
      const size = new DataView(mp4.buffer, mp4.byteOffset + off, 4).getUint32(0);
      const type = String.fromCharCode(mp4[off + 4], mp4[off + 5], mp4[off + 6], mp4[off + 7]);
      if (size < 8 || off + size > end) return null;
      if (type === want && idx++ === wantIdx) {
        found = { off, size, type, body: mp4.subarray(off + 8, off + size) };
        break;
      }
      off += size;
    }
    if (!found) return null;
    // full box 多 4 字节 version/flags，跳过它进入子级
    const FULL = new Set(['tkhd', 'mdhd', 'hdlr', 'stsd', 'stts', 'ctts', 'stss', 'stsc', 'stsz', 'stco', 'mvhd', 'dref', 'url ', 'esds', 'smhd', 'vmhd']);
    if (FULL.has(found.type)) start = found.off + 8 + 4;
    else start = found.off + 8;
    end = found.off + found.size;
  }
  return found;
}
