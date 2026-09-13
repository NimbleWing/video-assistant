// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SaveSession } from '../../src/net/save-session.js';
import { fsFileExists, resolveDir } from '../../src/net/fswriter.js';
import { makeFsMock } from '../helpers/fs-mock.js';
import {
  annexB, findBox, makeSps, tsPackets,
} from '../helpers/ts-fixture.js';

const VID_PID = 0x100;
const AUD_PID = 0x101;

/** 与 ts-remux-stream.test.js 同构的分段夹具（AU/PES/分段三者对齐）。 */
function makeStream({ au = 6, ptsStep = 3000 } = {}) {
  const sps = makeSps(3, 1);
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
    const frame = [0xff, 0xf1, 0x50, 0x80, 0x01, 0x7f, 0xfc, k + 1, k + 1, k + 1, k + 1];
    const parts = [
      tsPackets(VID_PID, 0xe0, new Uint8Array(vNals), pts),
      tsPackets(AUD_PID, 0xc0, new Uint8Array(frame), pts),
    ];
    const seg = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) { seg.set(p, o); o += p.length; }
    segments.push(seg);
  }
  return segments;
}

const INFO = { fingerprint: 'pl|6|first|last', segTotal: 6 };

/** @param {any} root @param {string} name @returns {Promise<Uint8Array>} */
async function readBytes(root, name) {
  const e = await resolveDir(root, name, false);
  if (!e) throw new Error('文件不存在（夹具错误）');
  const fh = await e.dir.getFileHandle(e.base, { create: false });
  const f = await fh.getFile();
  return new Uint8Array(await f.arrayBuffer());
}

/** 定位文件尾部的 moov box（largesize mdat 布局专用断言工具）。 */
function tailMoov(/** @type {Uint8Array} */ buf) {
  for (let pos = buf.length - 4; pos >= 4; pos--) {
    if (buf[pos] === 0x6d && buf[pos + 1] === 0x6f && buf[pos + 2] === 0x6f && buf[pos + 3] === 0x76) {
      const size = new DataView(buf.buffer, buf.byteOffset + pos - 4, 4).getUint32(0);
      if (pos - 4 + size === buf.length) return buf.subarray(pos - 4);
    }
  }
  throw new Error('未找到尾部 moov');
}

/**
 * 完整跑一轮（可指定中断/续传点）。
 * @param {any} root
 * @param {Uint8Array[]} segments
 * @param {{ abortAfter?: number, fp?: string }} [opts]
 * @returns {Promise<Uint8Array>} 最终文件字节
 */
async function runDownload(root, segments, { abortAfter = -1, fp = INFO.fingerprint } = {}) {
  const info = { ...INFO, fingerprint: fp };
  let b = await SaveSession.begin(root, '剧集/第1集.mp4', info);
  if (b.done) return readBytes(root, '剧集/第1集.mp4');
  const from = b.resumeFrom;
  for (let i = from; i < segments.length; i++) {
    await b.session.pushSegment(segments[i]);
    if (i === abortAfter) {
      await b.session.abort();
      const b2 = await SaveSession.begin(root, '剧集/第1集.mp4', info);
      if (b2.done) return readBytes(root, '剧集/第1集.mp4');
      expect(b2.resumeFrom).toBe(i + 1);
      b = b2;
    }
  }
  const fin = await b.session.finalize();
  return readBytes(root, fin.finalName);
}

describe('SaveSession 完整流程', () => {
  it('全新下载：mp4 结构完整（ftyp|largesize mdat|moov 置尾）', async () => {
    const { root } = makeFsMock();
    const buf = await runDownload(root, makeStream());
    // ftyp
    expect(String.fromCharCode(...buf.subarray(4, 8))).toBe('ftyp');
    // largesize mdat：size=1 + 'mdat' + 8 字节总长
    expect(new DataView(buf.buffer, buf.byteOffset + 32, 4).getUint32(0)).toBe(1);
    expect(String.fromCharCode(...buf.subarray(36, 40))).toBe('mdat');
    const large = new DataView(buf.buffer, buf.byteOffset + 40, 8).getBigUint64(0);
    const moov = tailMoov(buf);
    expect(Number(large)).toBe(buf.length - 32 - moov.length);
    // moov 内置 stco 指向文件内正确样本（首样本 AVCC 前缀 5 + IDR 头）
    const stco = findBox(moov, 'moov/trak[0]/mdia/minf/stbl/stco');
    if (!stco) throw new Error('缺少 stco');
    const off0 = new DataView(stco.body.buffer, stco.body.byteOffset + 8, 4).getUint32(0);
    expect(new DataView(buf.buffer, buf.byteOffset + off0, 4).getUint32(0)).toBe(5);
    expect(buf[off0 + 4]).toBe(0x65);
    // sidecar 与 .part 已清理
    expect(await fsFileExists(root, '剧集/第1集.part')).toBe(false);
    expect(await fsFileExists(root, '剧集/第1集.part.json')).toBe(false);
  });

  it('已存在判定：完成后 begin 直接 done', async () => {
    const { root } = makeFsMock();
    await runDownload(root, makeStream());
    const b = await SaveSession.begin(root, '剧集/第1集.mp4', INFO);
    expect(b.done).toBe(true);
  });

  it('断点续传：abort 后续传结果与一气呵成逐字节一致', async () => {
    const segments = makeStream();
    const { root: r1 } = makeFsMock();
    const oneShot = await runDownload(r1, segments);
    const { root: r2 } = makeFsMock();
    const resumed = await runDownload(r2, segments, { abortAfter: 2 });
    expect(Buffer.from(resumed).equals(Buffer.from(oneShot))).toBe(true);
  });

  it('指纹不符：废弃半成品重新下载', async () => {
    const { root } = makeFsMock();
    const segments = makeStream();
    const b = await SaveSession.begin(root, '剧集/第1集.mp4', INFO);
    await b.session.pushSegment(segments[0]);
    await b.session.pushSegment(segments[1]);
    await b.session.abort();
    const b2 = await SaveSession.begin(root, '剧集/第1集.mp4', { ...INFO, fingerprint: '别的播放列表' });
    expect(b2.done).toBe(false);
    expect(b2.resumeFrom).toBe(0);
    // 旧 .part 已废弃（重新 undecided）
    const fin = await (async () => {
      for (let i = 0; i < segments.length; i++) await b2.session.pushSegment(segments[i]);
      return b2.session.finalize();
    })();
    expect(fin.finalName).toBe('剧集/第1集.mp4');
  });
});

describe('SaveSession 透传与边界', () => {
  it('非 TS 输入超验证上限 → 透传 .ts 且内容原始', async () => {
    const { root } = makeFsMock();
    const junk = [new Uint8Array(100).fill(1), new Uint8Array(100).fill(2), new Uint8Array(100).fill(3)];
    const b = await SaveSession.begin(root, '片/x.mp4', { fingerprint: 'j|3|a|b', segTotal: 3 }, { validateLimit: 150 });
    for (const j of junk) await b.session.pushSegment(j);
    const fin = await b.session.finalize();
    expect(fin.finalName).toBe('片/x.ts');
    expect(fin.note).not.toBe('');
    const buf = await readBytes(root, '片/x.ts');
    expect(buf.length).toBe(300);
    expect(buf[0]).toBe(1);
    expect(buf[299]).toBe(3);
  });

  it('透传也可断点续传', async () => {
    const { root } = makeFsMock();
    const junk = [new Uint8Array(100).fill(1), new Uint8Array(100).fill(2), new Uint8Array(100).fill(3)];
    const info = { fingerprint: 'j|3|a|b', segTotal: 3 };
    const b = await SaveSession.begin(root, '片/x.mp4', info, { validateLimit: 150 });
    await b.session.pushSegment(junk[0]);
    await b.session.pushSegment(junk[1]);
    await b.session.abort();
    const b2 = await SaveSession.begin(root, '片/x.mp4', info, { validateLimit: 150 });
    expect(b2.resumeFrom).toBe(2);
    await b2.session.pushSegment(junk[2]);
    const fin = await b2.session.finalize();
    const buf = await readBytes(root, fin.finalName);
    expect(buf.length).toBe(300);
    expect(buf[199]).toBe(2);
    expect(buf[299]).toBe(3);
  });

  it('undecided 阶段 abort 不落盘；undecided 收尾一锤定音', async () => {
    const { root } = makeFsMock();
    const segments = makeStream({ au: 1 }); // 单分段：推入后 validated 未翻真（PES 滞后）
    const b = await SaveSession.begin(root, '小片/a.mp4', { fingerprint: 's|1|x|y', segTotal: 1 });
    await b.session.pushSegment(segments[0]);
    await b.session.abort(); // undecided abort：无文件
    expect(await fsFileExists(root, '小片/a.part')).toBe(false);
    // 重新完整下载（undecided finalize 一锤定音 → mp4）
    const b2 = await SaveSession.begin(root, '小片/a.mp4', { fingerprint: 's|1|x|y', segTotal: 1 });
    await b2.session.pushSegment(segments[0]);
    const fin = await b2.session.finalize();
    expect(fin.finalName).toBe('小片/a.mp4');
    const buf = await readBytes(root, '小片/a.mp4');
    expect(String.fromCharCode(...buf.subarray(4, 8))).toBe('ftyp');
  });
});
