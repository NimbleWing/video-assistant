import { resolveUrl, toAbsolute } from '../core/utils.js';
import { hexToBytes, sequenceIv } from '../core/crypto.js';

/**
 * @typedef {Object} Segment
 * @property {string} url
 * @property {Uint8Array<ArrayBuffer>} iv
 * @property {number} seq
 * @property {number} duration
 */

/**
 * @typedef {Object} MediaPlaylist
 * @property {Segment[]} segments
 * @property {string} keyUri 解密钥地址（明文流为空串）
 * @property {number} duration 由 EXTINF 累加的总时长（秒）
 */

/**
 * @typedef {Object} Variant
 * @property {string} label
 * @property {string} resolution
 * @property {number} bandwidth
 * @property {number} height
 * @property {string} url
 * @property {string} prefix
 * @property {number} [duration] 由调用方解析媒体列表后回填
 * @property {number} [segments] 由调用方解析媒体列表后回填
 */

/**
 * 是否播放列表地址（含本站伪装成图片的 m3u8）。
 * @param {unknown} url
 * @returns {boolean}
 */
export function isPlaylistUrl(url) {
  const s = String(url || '');
  if (!s || /^blob:/i.test(s)) return false;
  return /\/api\/hls\//i.test(s)
    || /\.m3u8(\?|#|$)/i.test(s)
    || /\/(?:index|master)\.(?:m3u8|jpg|jpeg|png)(\?|#|$)/i.test(s);
}

/**
 * 由视频地址生成候选播放列表地址（站点把 m3u8 伪装成 index.png/jpg）。
 * @param {string} videoUrl
 * @returns {string[]}
 */
export function playlistCandidates(videoUrl) {
  /** @type {string[]} */
  const out = [];
  const add = (/** @type {string} */ u) => { if (u && !out.includes(u)) out.push(u); };
  const abs = toAbsolute(videoUrl);
  add(abs);
  add(videoUrl);
  try {
    const u = new URL(abs);
    const names = ['index.png', 'index.jpg', 'index.m3u8', 'master.m3u8'];
    const m = u.pathname.match(/\/(index|master)\.(png|jpg|jpeg|m3u8)$/i);
    if (m) {
      for (const name of names) {
        const alt = new URL(abs);
        alt.pathname = u.pathname.replace(/\/(index|master)\.(png|jpg|jpeg|m3u8)$/i, `/${name}`);
        add(alt.href);
      }
    }
  } catch {}
  return out;
}

/**
 * 解析 master 播放列表，按清晰度降序返回变体。
 * @param {string} text
 * @param {string} baseUrl
 * @returns {Variant[]}
 */
export function parseMasterPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  /** @type {Variant[]} */
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const meta = line.slice('#EXT-X-STREAM-INF:'.length);
    let next = '';
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && !lines[j].trim().startsWith('#')) { next = lines[j].trim(); break; }
    }
    if (!next) continue;
    const res = (meta.match(/RESOLUTION=(\d+x\d+)/i) || [])[1] || '';
    const bw = Number((meta.match(/BANDWIDTH=(\d+)/i) || [])[1] || 0);
    const name = (meta.match(/NAME="?([^",]+)"?/i) || [])[1] || '';
    const height = Number(res.split('x')[1] || name.match(/(\d{3,4})/)?.[1] || 0);
    variants.push({
      label: name || (height ? `${height}p` : 'Source'),
      resolution: res,
      bandwidth: bw,
      height: height || 0,
      url: resolveUrl(baseUrl, next),
      prefix: resolveUrl(baseUrl, next.replace(/[^/]+$/, '')),
    });
  }
  variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  return variants;
}

/**
 * 解析媒体播放列表为分段数组（含每段 IV 与解密钥地址）。
 * @param {string} text
 * @param {string} baseUrl
 * @returns {MediaPlaylist}
 */
export function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  /** @type {Segment[]} */
  const segments = [];
  let keyUri = '';
  /** @type {Uint8Array<ArrayBuffer> | null} */
  let keyIv = null;
  let seq = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      seq = Number(line.split(':')[1]) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const method = (line.match(/METHOD=([^,]+)/) || [])[1];
      if (method === 'NONE') { keyUri = ''; keyIv = null; }
      else if (method === 'AES-128') {
        const uri = (line.match(/URI="([^"]+)"/) || [])[1] || '';
        const ivHex = (line.match(/IV=0x([0-9a-f]+)/i) || [])[1];
        keyUri = resolveUrl(baseUrl, uri);
        keyIv = ivHex ? hexToBytes(ivHex) : null;
      }
    } else if (line.startsWith('#EXTINF')) {
      let path = '';
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() && !lines[j].trim().startsWith('#')) { path = lines[j].trim(); break; }
      }
      if (!path) continue;
      const iv = keyIv || sequenceIv(seq);
      const duration = Number((line.match(/#EXTINF:([\d.]+)/) || [])[1] || 0);
      segments.push({ url: resolveUrl(baseUrl, path), iv, seq, duration });
      seq++;
    }
  }
  const duration = segments.reduce((sum, seg) => sum + (Number(seg.duration) || 0), 0);
  return { segments, keyUri, duration };
}
