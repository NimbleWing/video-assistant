// Minimal MPEG-TS → MP4 (H.264/AAC) remuxer, ported unchanged from the
// userscript. Demuxes TS packets into AVC/AAC samples and muxes a plain MP4.
export const TsRemux = (function () {
'use strict';

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
}

function u16(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n & 0xffff);
  return b;
}

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

function fullBox(type, ver, flags, payload) {
  const head = new Uint8Array(4);
  head[0] = ver;
  head[1] = (flags >> 16) & 255;
  head[2] = (flags >> 8) & 255;
  head[3] = flags & 255;
  return box(type, concat([head, payload]));
}

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
  constructor(u8) { this.d = u8; this.p = 0; }
  u(n) {
    let v = 0;
    while (n--) {
      const bi = this.p >> 3, bo = 7 - (this.p & 7);
      v = (v << 1) | ((this.d[bi] >> bo) & 1);
      this.p++;
    }
    return v;
  }
  ue() {
    let z = 0;
    while (this.u(1) === 0) z++;
    return z ? ((1 << z) - 1) + this.u(z) : 0;
  }
  se() {
    const v = this.ue();
    return (v & 1) ? (v + 1) >> 1 : -(v >> 1);
  }
}

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

function splitNals(data) {
  const nals = [];
  let i = 0;
  const find = (from) => {
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

function nalsToAvcc(nals) {
  const parts = [];
  for (const nal of nals) {
    parts.push(u32(nal.length), nal);
  }
  return concat(parts);
}

function parsePts(d, off) {
  return ((d[off] & 0x0e) << 29) +
    ((d[off + 1] & 0xff) << 22) +
    ((d[off + 2] & 0xfe) << 14) +
    ((d[off + 3] & 0xff) << 7) +
    ((d[off + 4] & 0xfe) >> 1);
}

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

function demuxTs(ts) {
  const pesAcc = {};
  const es = {};

  const finishPes = (pid) => {
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

  const pushPes = (pid, payload, pusi) => {
    if (pusi) {
      finishPes(pid);
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

  let sps, pps, width = 0, height = 0, profile = 100, level = 31;
  let sampleRate = 44100, channels = 2, aacProfile = 2;
  const video = [];
  const audio = [];

  const ptsFor = (stream, off, fallback) => {
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

function stts(samples, timescale, getPts, getDurFallback) {
  const entries = [];
  for (let i = 0; i < samples.length; i++) {
    let dur;
    if (i + 1 < samples.length) dur = Math.max(1, getPts(samples[i + 1]) - getPts(samples[i]));
    else dur = getDurFallback;
    if (entries.length && entries[entries.length - 1].dur === dur) entries[entries.length - 1].cnt++;
    else entries.push({ cnt: 1, dur });
  }
  const body = [u32(entries.length)];
  for (const e of entries) body.push(u32(e.cnt), u32(e.dur));
  return fullBox('stts', 0, 0, concat(body));
}

function muxMp4(demuxed) {
  const { video, audio, meta } = demuxed;
  if (!video.length) throw new Error('没有视频帧');
  if (!meta.sps || !meta.pps) throw new Error('缺少 SPS/PPS');

  const vTimescale = 90000;
  const aTimescale = meta.sampleRate || 44100;
  const vStart = video[0].pts;
  const aStart = audio.length ? audio[0].pts : vStart;

  const vDurs = [];
  for (let i = 0; i < video.length; i++) {
    const p = video[i].pts - vStart;
    video[i].rel = p;
    if (i + 1 < video.length) vDurs.push(Math.max(1, video[i + 1].pts - video[i].pts));
  }
  const vFallback = vDurs.length ? vDurs[vDurs.length - 1] : Math.round(vTimescale / 30);
  if (vDurs.length < video.length) vDurs.push(vFallback);
  let vDuration = vDurs.reduce((a, b) => a + b, 0);
  if (audio.length) {
    const aTicks = Math.round(audio.length * 1024 * vTimescale / aTimescale);
    if (aTicks > 0 && (vDuration > aTicks * 1.12 || vDuration < aTicks * 0.75)) {
      const tick = Math.max(1, Math.round(aTicks / video.length));
      for (let i = 0; i < video.length; i++) video[i].pts = vStart + i * tick;
      vDuration = tick * video.length;
    }
  }

  const aDurs = [];
  const aFrameDur = Math.round(1024 * 90000 / aTimescale);
  for (let i = 0; i < audio.length; i++) {
    audio[i].rel = (audio[i].pts == null ? vStart : audio[i].pts) - aStart;
    if (i + 1 < audio.length) aDurs.push(Math.max(1, audio[i + 1].pts - audio[i].pts));
    else aDurs.push(aFrameDur);
  }
  const aDuration = aDurs.reduce((a, b) => a + b, 0);
  const duration = Math.max(vDuration, aDuration);

  const mdats = [];
  const vOff = [];
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

  const avcC = concat([
    new Uint8Array([1, meta.sps[1], meta.sps[2], meta.sps[3], 0xff, 0xe1]),
    u16(meta.sps.length), meta.sps,
    new Uint8Array([1]),
    u16(meta.pps.length), meta.pps,
  ]);

  const avc1 = box('avc1', concat([
    new Uint8Array(6), u16(1),
    new Uint8Array(16),
    u16(meta.width), u16(meta.height),
    new Uint8Array([0x00, 0x48, 0x00, 0x00, 0x00, 0x48, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01]),
    new Uint8Array(32),
    new Uint8Array([0x00, 0x18, 0xff, 0xff]),
    box('avcC', avcC),
  ]));

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

  const mp4a = box('mp4a', concat([
    new Uint8Array(6), u16(1),
    new Uint8Array(8),
    u16(meta.channels), u16(16), new Uint8Array(4),
    u16(aTimescale), u16(0),
    esds,
  ]));

  function trak(id, isVideo) {
    const samples = isVideo ? video : audio;
    const timescale = isVideo ? vTimescale : aTimescale;
    const dur = isVideo ? vDuration : aDuration;
    const mdhdDur = isVideo ? vDuration : (audio.length * 1024);
    const tkhd = fullBox('tkhd', 0, 3, concat([
      u32(0), u32(0), u32(id), u32(0), u32(dur),
      new Uint8Array(8), u16(0), u16(0), u16(0), u16(0),
      new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0]),
      u32(isVideo ? meta.width << 16 : 0), u32(isVideo ? meta.height << 16 : 0),
    ]));
    const mdhd = fullBox('mdhd', 0, 0, concat([
      u32(0), u32(0), u32(timescale), u32(isVideo ? vDuration : mdhdDur),
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
    const stsd = fullBox('stsd', 0, 0, concat([u32(1), isVideo ? avc1 : mp4a]));
    const sttsBox = isVideo
      ? stts(video, vTimescale, (s) => s.pts, vFallback)
      : (() => {
        const entries = [{ cnt: audio.length, dur: 1024 }];
        return fullBox('stts', 0, 0, concat([u32(1), u32(entries[0].cnt), u32(1024)]));
      })();
    let stssBox = new Uint8Array(0);
    if (isVideo) {
      const keys = [];
      for (let i = 0; i < video.length; i++) if (video[i].isKey) keys.push(i + 1);
      if (!keys.length) keys.push(1);
      const body = [u32(keys.length)];
      for (const k of keys) body.push(u32(k));
      stssBox = fullBox('stss', 0, 0, concat(body));
    }
    const stsc = fullBox('stsc', 0, 0, concat([u32(1), u32(1), u32(1), u32(1)]));
    const sz = [u32(0), u32(samples.length)];
    for (const s of samples) sz.push(u32(s.data.length));
    const stsz = fullBox('stsz', 0, 0, concat(sz));
    const co = [u32(samples.length)];
    const offs = isVideo ? vOff : aOff;
    for (const o of offs) co.push(u32(o));
    const stco = fullBox('stco', 0, 0, concat(co));
    const stbl = box('stbl', concat([stsd, sttsBox, stssBox, stsc, stsz, stco].filter((x) => x.length)));
    const minf = box('minf', concat([mediaHead, dinf, stbl]));
    const mdia = box('mdia', concat([mdhd, hdlr, minf]));
    return box('trak', concat([tkhd, mdia]));
  }

  const mvhd = fullBox('mvhd', 0, 0, concat([
    u32(0), u32(0), u32(vTimescale), u32(duration),
    u32(0x00010000), u16(0x0100), u16(0), new Uint8Array(8),
    new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0]),
    new Uint8Array(24), u32(audio.length ? 3 : 2),
  ]));

  const moovParts = [mvhd, trak(1, true)];
  if (audio.length) moovParts.push(trak(2, false));
  const moov = box('moov', concat(moovParts));
  const ftyp = box('ftyp', concat([
    new Uint8Array([0x69, 0x73, 0x6f, 0x6d]), u32(0x200),
    new Uint8Array([0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32, 0x61, 0x76, 0x63, 0x31, 0x6d, 0x70, 0x34, 0x31]),
  ]));

  const mdatHead = 8;
  const mdatOffset = ftyp.length + moov.length + mdatHead;
  function patchStco(mp4) {
    const view = new DataView(mp4.buffer, mp4.byteOffset, mp4.byteLength);
    const walk = (start, end) => {
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

function remux(chunksOrTs) {
  let ts;
  if (Array.isArray(chunksOrTs)) ts = concat(chunksOrTs);
  else ts = chunksOrTs instanceof Uint8Array ? chunksOrTs : new Uint8Array(chunksOrTs);
  if (!isMpegTs(ts)) return ts;
  return muxMp4(demuxTs(ts));
}

return { isMpegTs, remux, demuxTs, muxMp4 };
})();
