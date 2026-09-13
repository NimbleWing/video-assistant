// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { TsRemux } from '../../src/hls/ts-remux.js';
import { annexB, findBox, makeSps, tsPackets } from '../helpers/ts-fixture.js';

const VID_PID = 0x100;
const AUD_PID = 0x101;

/** 造一个含 SPS/PPS 的两帧视频 TS（两个 AUD 分隔的访问单元）。 */
function makeVideoTs({ pts1 = 0, pts2 = 2090, withAudio = false } = {}) {
  const sps = makeSps(3, 1); // 64 x 32（frameMbsOnly=1 → height = (hM1+1)*16）
  const pps = [0x68, 0xeb, 0x3c, 0x80];
  const idr1 = [0x65, 0x88, 0x84, 0x00, 0x21];
  const aud = [0x09, 0x10];
  const idr2 = [0x41, 0x9a, 0x22, 0x11]; // 非关键帧
  const parts = [
    tsPackets(VID_PID, 0xe0, new Uint8Array([...annexB(sps), ...annexB(pps), ...annexB(idr1)]), pts1),
    tsPackets(VID_PID, 0xe0, new Uint8Array([...annexB(aud), ...annexB(idr2)]), pts2),
  ];
  if (withAudio) {
    // ADTS: 44100Hz 立体声 AAC-LC，4 字节载荷
    /** @param {number} n */
    const frame = (n) => [0xff, 0xf1, 0x50, 0x80, 0x01, 0x7f, 0xfc, n, n, n, n];
    parts.push(
      tsPackets(AUD_PID, 0xc0, new Uint8Array(frame(0x11)), pts1),
      tsPackets(AUD_PID, 0xc0, new Uint8Array(frame(0x22)), pts2),
    );
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** 读出 u32 大端。 @param {Uint8Array} u8 @param {number} off */
function ru32(u8, off) {
  return new DataView(u8.buffer, u8.byteOffset + off, 4).getUint32(0);
}

/** 断言非空并收窄。 @template T @param {T | null} v @returns {T} */
function nn(v) {
  if (v == null) throw new Error('期望的 box 不存在');
  return v;
}

describe('isMpegTs', () => {
  it('识别 0x47 同步字节流', () => {
    expect(TsRemux.isMpegTs(makeVideoTs())).toBe(true);
  });
  it('拒绝非 TS 与过短输入', () => {
    expect(TsRemux.isMpegTs(new Uint8Array(100))).toBe(false);
    expect(TsRemux.isMpegTs(new Uint8Array([0x47]))).toBe(false);
    expect(TsRemux.isMpegTs(null)).toBe(false);
  });
});

describe('demuxTs', () => {
  it('分离视频样本并解析 SPS 元数据', () => {
    const d = TsRemux.demuxTs(makeVideoTs());
    expect(d.video.length).toBe(2);
    expect(d.video[0].isKey).toBe(true);  // IDR
    expect(d.video[1].isKey).toBe(false); // 非 IDR
    expect(d.meta.width).toBe(64);
    expect(d.meta.height).toBe(32);
    expect(d.meta.profile).toBe(100);
    expect(d.meta.sps?.[0]).toBe(0x67);
    expect(d.meta.pps?.[0]).toBe(0x68);
  });

  it('样本 PTS 取自 PES 时间戳', () => {
    const d = TsRemux.demuxTs(makeVideoTs({ pts1: 90000, pts2: 180000 }));
    expect(d.video[0].pts).toBe(90000);
    expect(d.video[1].pts).toBe(180000);
  });

  // 回归：v1.7.0 修复 —— 33 位 PTS 用 <<29 会溢出成负数（位运算是 32 位有符号）
  it('回归：PTS ≥ 2^32 不溢出为负数', () => {
    const big = 0x1ffff0000; // ≈ 34GB 的 90kHz 刻度，远超 2^31
    const d = TsRemux.demuxTs(makeVideoTs({ pts1: big, pts2: big + 3000 }));
    expect(d.video[0].pts).toBe(big);
    expect(d.video[0].pts).toBeGreaterThan(0);
    expect(d.video[1].pts).toBe(big + 3000);
  });

  it('分离音频样本并解析 ADTS 参数', () => {
    const d = TsRemux.demuxTs(makeVideoTs({ withAudio: true }));
    expect(d.audio.length).toBe(2);
    expect(d.meta.sampleRate).toBe(44100);
    expect(d.meta.channels).toBe(2);
    expect(d.meta.aacProfile).toBe(2); // AAC LC
    // 剥离 ADTS 头，载荷原样保留
    expect(Array.from(d.audio[0].data)).toEqual([0x11, 0x11, 0x11, 0x11]);
  });
});

describe('muxMp4 结构', () => {
  it('产出 ftyp+moov+mdat 且 box 树完整', () => {
    const mp4 = TsRemux.remux(makeVideoTs({ withAudio: true }));
    expect(String.fromCharCode(...mp4.subarray(4, 8))).toBe('ftyp');
    expect(findBox(mp4, 'moov')?.type).toBe('moov');
    expect(findBox(mp4, 'moov/trak[0]')?.type).toBe('trak');
    expect(findBox(mp4, 'moov/trak[1]')?.type).toBe('trak');
    expect(findBox(mp4, 'mdat')?.type).toBe('mdat');
    expect(findBox(mp4, 'moov/trak[0]/mdia/minf/stbl/stco')?.type).toBe('stco');
  });

  // 回归：v1.2.1 修复 —— hdlr 轨道类型缺第 4 字节（'vid' → Windows 读不出媒体属性）
  it('回归：hdlr handler_type 为完整 4 字节 vide/soun', () => {
    const mp4 = TsRemux.remux(makeVideoTs({ withAudio: true }));
    const vh = nn(findBox(mp4, 'moov/trak[0]/mdia/hdlr'));
    const ah = nn(findBox(mp4, 'moov/trak[1]/mdia/hdlr'));
    // fullBox 头 4 字节 + pre_defined 4 字节后才是 handler_type
    expect(String.fromCharCode(...vh.body.subarray(8, 12))).toBe('vide');
    expect(String.fromCharCode(...ah.body.subarray(8, 12))).toBe('soun');
    // handler 名称需以 NUL 结尾
    expect(vh.body[vh.body.length - 1]).toBe(0);
  });

  // 回归：v1.2.1 修复 —— tkhd 单位矩阵缺一个 0（35 字节 → 时长等属性丢失）
  it('回归：tkhd 含 36 字节单位矩阵与正确宽高', () => {
    const mp4 = TsRemux.remux(makeVideoTs());
    const tkhd = nn(findBox(mp4, 'moov/trak[0]/tkhd'));
    const body = tkhd.body;
    // fullBox(4) + ctime(4) + mtime(4) + trackId(4) + reserved(4) + duration(4)
    // + reserved(8) + layer(2) + altGroup(2) + volume(2) + reserved(2) = 矩阵起点 40
    const m = 40;
    expect(ru32(body, m + 0)).toBe(0x00010000);
    expect(ru32(body, m + 4)).toBe(0);
    expect(ru32(body, m + 8)).toBe(0);
    expect(ru32(body, m + 12)).toBe(0);
    expect(ru32(body, m + 16)).toBe(0x00010000);
    expect(ru32(body, m + 20)).toBe(0);
    expect(ru32(body, m + 24)).toBe(0);
    expect(ru32(body, m + 28)).toBe(0);
    expect(ru32(body, m + 32)).toBe(0x40000000);
    // 宽高为 16.16 定点
    expect(ru32(body, m + 36)).toBe(64 << 16);
    expect(ru32(body, m + 40)).toBe(32 << 16);
  });

  it('stss 仅列关键帧；无关键帧兜底第 1 帧', () => {
    const mp4 = TsRemux.remux(makeVideoTs());
    const stss = nn(findBox(mp4, 'moov/trak[0]/mdia/minf/stbl/stss'));
    // fullBox 头 4 字节 + 条目数
    expect(ru32(stss.body, 4)).toBe(1);
    expect(ru32(stss.body, 8)).toBe(1); // 第 1 帧是关键帧
  });

  it('stco 偏移经 patch 后指向 mdat 载荷内的样本起点', () => {
    const mp4 = TsRemux.remux(makeVideoTs());
    const stco = nn(findBox(mp4, 'moov/trak[0]/mdia/minf/stbl/stco'));
    const mdat = nn(findBox(mp4, 'mdat'));
    const count = ru32(stco.body, 4);
    expect(count).toBe(2); // 两个视频样本
    const off0 = ru32(stco.body, 8);
    const off1 = ru32(stco.body, 12);
    // 偏移必须落在 mdat 载荷区间
    expect(off0).toBeGreaterThanOrEqual(mdat.off + 8);
    expect(off0).toBeLessThan(mdat.off + mdat.size);
    expect(off1).toBeGreaterThan(off0);
    // 第一个样本以 AVCC 长度前缀开头（IDR1 = 5 字节）
    expect(ru32(mp4, off0)).toBe(5);
    expect(mp4[off0 + 4]).toBe(0x65); // IDR NAL 头
  });

  it('mvhd 时长为视频总时长（90kHz）', () => {
    const mp4 = TsRemux.remux(makeVideoTs({ pts1: 0, pts2: 2090 }));
    const mvhd = nn(findBox(mp4, 'moov/mvhd'));
    // fullBox(4) + ctime(4) + mtime(4) + timescale(4) + duration(4)
    expect(ru32(mvhd.body, 12)).toBe(90000);
    expect(ru32(mvhd.body, 16)).toBe(4180); // 两段各 2090 tick
  });

  it('无 SPS/PPS 抛出 缺少 SPS/PPS', () => {
    // 只塞 IDR，不含 SPS/PPS
    const idr = [0x65, 0x88, 0x84];
    const ts = tsPackets(VID_PID, 0xe0, new Uint8Array(annexB(idr)), 0);
    expect(() => TsRemux.remux(ts)).toThrow('缺少 SPS/PPS');
  });

  it('非 TS 输入原样返回', () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5]);
    const out = TsRemux.remux(junk);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5]);
  });

  it('分段数组输入与拼接输入结果一致', () => {
    const ts = makeVideoTs();
    const mid = Math.floor(ts.length / 2 / 188) * 188;
    const asChunks = TsRemux.remux([ts.subarray(0, mid), ts.subarray(mid)]);
    const asWhole = TsRemux.remux(ts);
    expect(asChunks.length).toBe(asWhole.length);
    expect(Buffer.from(asChunks).equals(Buffer.from(asWhole))).toBe(true);
  });
});
