// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { TsRemux } from '../../src/hls/ts-remux.js';
import { annexB, findBox, makeSps, tsPackets } from '../helpers/ts-fixture.js';

const VID_PID = 0x100;
const AUD_PID = 0x101;

/**
 * 造多 AU 流媒体夹具：每段 = 1 个视频 PES + 1 个音频 PES（PES/AU/分段三者对齐）。
 * @param {{ au?: number, ptsStep?: number, withAudio?: boolean }} [opts]
 * @returns {{ segments: Uint8Array[], whole: Uint8Array }}
 */
function makeStream({ au = 6, ptsStep = 3000, withAudio = true } = {}) {
  const sps = makeSps(3, 1); // 64 x 32
  const pps = [0x68, 0xeb, 0x3c, 0x80];
  const aud = [0x09, 0x10];
  /** @type {Uint8Array[]} */
  const segments = [];
  for (let k = 0; k < au; k++) {
    const pts = k * ptsStep;
    const vcl = k === 0 ? [0x65, 0x88, 0x84, 0x00, 0x21] : [0x41, 0x9a, 0x22, 0x11, k & 0xff];
    const vNals = k === 0
      ? [...annexB(sps), ...annexB(pps), ...annexB(vcl)]
      : [...annexB(aud), ...annexB(vcl)];
    /** @type {Uint8Array[]} */
    const parts = [tsPackets(VID_PID, 0xe0, new Uint8Array(vNals), pts)];
    if (withAudio) {
      // ADTS: 44100Hz 双声道 AAC-LC，4 字节负载
      const frame = [0xff, 0xf1, 0x50, 0x80, 0x01, 0x7f, 0xfc, k + 1, k + 1, k + 1, k + 1];
      parts.push(tsPackets(AUD_PID, 0xc0, new Uint8Array(frame), pts));
    }
    const seg = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) { seg.set(p, o); o += p.length; }
    segments.push(seg);
  }
  const whole = new Uint8Array(segments.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const s of segments) { whole.set(s, o); o += s.length; }
  return { segments, whole };
}

/** @param {Uint8Array[]} parts @returns {Uint8Array} */
function cat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** @param {Uint8Array} u8 @param {number} off @returns {number} */
function ru32(u8, off) {
  return new DataView(u8.buffer, u8.byteOffset + off, 4).getUint32(0);
}

/** @template T @param {T | null | undefined} v @returns {T} */
function nn(v) {
  if (v == null) throw new Error('找不到 box（夹具错误）');
  return v;
}

/**
 * 流式跑完整个夹具：可选每段 checkpoint。
 * @param {Uint8Array[]} segments
 * @param {{ checkpoints?: boolean, snapshotAt?: number }} [opts]
 * @returns {{ mdat: Uint8Array, moov: Uint8Array, mdatPayload: number, session: any }}
 */
function runStreaming(segments, { checkpoints = false, snapshotAt = -1 } = {}) {
  let session = TsRemux.createStreamingRemux();
  /** @type {Uint8Array[]} */
  const mdatParts = [];
  for (let i = 0; i < segments.length; i++) {
    mdatParts.push(...session.push(segments[i]));
    if (checkpoints) {
      const cp = session.checkpoint();
      mdatParts.push(...cp.mdat);
      if (i === snapshotAt) {
        // 模拟崩溃恢复：从快照换新会话继续
        session = TsRemux.createStreamingRemux(cp.snapshot);
      }
    }
  }
  const fin = session.finalize();
  mdatParts.push(...fin.mdat);
  return { mdat: cat(mdatParts), moov: fin.moov, mdatPayload: fin.mdatPayload, session };
}

describe('流式 remux：与单遍等价', () => {
  it('mdat 负载与单遍逐字节一致', () => {
    const { segments, whole } = makeStream();
    const oneShot = TsRemux.remux(whole);
    const oneMdat = nn(findBox(oneShot, 'mdat'));
    const s = runStreaming(segments);
    expect(s.mdat.length).toBe(oneMdat.body.length);
    expect(Buffer.from(s.mdat).equals(Buffer.from(oneMdat.body))).toBe(true);
  });

  it('moov 表项与单遍一致（stts/stsz/stss/mvhd/tkhd/mdhd）', () => {
    const { segments, whole } = makeStream();
    const oneShot = TsRemux.remux(whole);
    const s = runStreaming(segments);
    const paths = [
      'moov/mvhd',
      'moov/trak[0]/tkhd', 'moov/trak[0]/mdia/mdhd', 'moov/trak[0]/mdia/minf/stbl/stts',
      'moov/trak[0]/mdia/minf/stbl/stss', 'moov/trak[0]/mdia/minf/stbl/stsz',
      'moov/trak[1]/tkhd', 'moov/trak[1]/mdia/mdhd', 'moov/trak[1]/mdia/minf/stbl/stts',
      'moov/trak[1]/mdia/minf/stbl/stsz',
    ];
    for (const p of paths) {
      const a = nn(findBox(oneShot, p));
      const b = nn(findBox(s.moov, p));
      expect(Buffer.from(b.body).equals(Buffer.from(a.body)), p).toBe(true);
    }
  });

  it('stco 相对 mdat 负载偏移与单遍一致（布局基准不同而已）', () => {
    const { segments, whole } = makeStream();
    const oneShot = TsRemux.remux(whole);
    const oneMoov = nn(findBox(oneShot, 'moov'));
    const oneStco = nn(findBox(oneShot, 'moov/trak[0]/mdia/minf/stbl/stco'));
    const s = runStreaming(segments);
    const sStco = nn(findBox(s.moov, 'moov/trak[0]/mdia/minf/stbl/stco'));
    const ftypLen = 8 + 24;
    const oneBase = ftypLen + oneMoov.size + 8;
    const sBase = ftypLen + TsRemux.MDAT_HEADER;
    const count = ru32(oneStco.body, 4);
    expect(ru32(sStco.body, 4)).toBe(count);
    for (let i = 0; i < count; i++) {
      const oneRel = ru32(oneStco.body, 8 + i * 4) - oneBase;
      const sRel = ru32(sStco.body, 8 + i * 4) - sBase;
      expect(sRel).toBe(oneRel);
    }
    // stco 指向的样本内容与单遍一致（首样本 AVCC 长度前缀 + NAL 头）
    const off0 = ru32(sStco.body, 8) - sBase;
    expect(ru32(s.mdat, off0)).toBe(5);
    expect(s.mdat[off0 + 4]).toBe(0x65);
  });

  it('每个 checkpoint 后 mdatPayload 与已写 mdat 字节一致', () => {
    const { segments } = makeStream();
    const session = TsRemux.createStreamingRemux();
    let written = 0;
    for (const seg of segments) {
      for (const c of session.push(seg)) written += c.length;
      const cp = session.checkpoint();
      for (const c of cp.mdat) written += c.length;
      expect(cp.snapshot.mdatPayload).toBe(written);
    }
  });
});

describe('流式 remux：分块与检查点不变性', () => {
  it('188 字节碎块推入与整段推入结果一致', () => {
    const { segments, whole } = makeStream();
    const ref = runStreaming(segments);
    const session = TsRemux.createStreamingRemux();
    /** @type {Uint8Array[]} */
    const parts = [];
    for (let i = 0; i < whole.length; i += 188) {
      parts.push(...session.push(whole.subarray(i, i + 188)));
    }
    const fin = session.finalize();
    parts.push(...fin.mdat);
    expect(Buffer.from(cat(parts)).equals(Buffer.from(ref.mdat))).toBe(true);
    expect(Buffer.from(fin.moov).equals(Buffer.from(ref.moov))).toBe(true);
  });

  it('每段 checkpoint 与不 checkpoint 结果一致', () => {
    const { segments } = makeStream();
    const a = runStreaming(segments, { checkpoints: false });
    const b = runStreaming(segments, { checkpoints: true });
    expect(Buffer.from(b.mdat).equals(Buffer.from(a.mdat))).toBe(true);
    expect(Buffer.from(b.moov).equals(Buffer.from(a.moov))).toBe(true);
  });

  it('快照恢复（模拟崩溃续传）与不中断结果一致', () => {
    const { segments } = makeStream();
    const ref = runStreaming(segments, { checkpoints: true });
    const resumed = runStreaming(segments, { checkpoints: true, snapshotAt: 2 });
    expect(Buffer.from(resumed.mdat).equals(Buffer.from(ref.mdat))).toBe(true);
    expect(Buffer.from(resumed.moov).equals(Buffer.from(ref.moov))).toBe(true);
  });
});

describe('流式 remux：状态与校验', () => {
  it('validated：PES 有一拍滞后，第二段推入后验证通过', () => {
    const { segments } = makeStream();
    const session = TsRemux.createStreamingRemux();
    expect(session.validated).toBe(false);
    session.push(segments[0]);
    // 首个 PES 仍在装配器里（等下一个 PUSI 收尾），尚未消费
    expect(session.validated).toBe(false);
    session.push(segments[1]);
    expect(session.validated).toBe(true);
  });

  it('空输入 finalize 抛 没有视频帧', () => {
    const session = TsRemux.createStreamingRemux();
    expect(() => session.finalize()).toThrow('没有视频帧');
  });

  it('纯视频流（无音频）按窗口冲刷且结构完整', () => {
    const { segments } = makeStream({ au: 200, ptsStep: 3000, withAudio: false }); // 600000 tick > 窗口
    const session = TsRemux.createStreamingRemux();
    let drained = 0;
    for (const seg of segments) drained += session.push(seg).length;
    expect(drained).toBeGreaterThan(0); // 窗口冲刷生效，非全程驻留
    const fin = session.finalize();
    const moov = fin.moov;
    expect(findBox(moov, 'moov/trak[1]')).toBeNull(); // 无音轨
    const mvhd = nn(findBox(moov, 'moov/mvhd'));
    expect(ru32(mvhd.body, 16)).toBe(200 * 3000); // 时长 = 200 AU × 3000 tick
  });
});
