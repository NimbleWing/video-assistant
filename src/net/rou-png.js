// Site wraps HLS playlists in a 1x1 PNG with a custom `roUd` chunk
// (flag&1 = zlib deflate). This module unwraps that disguise.
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 是否 PNG 文件头。
 * @param {Uint8Array | null | undefined} u8
 * @returns {boolean}
 */
export function looksLikePng(u8) {
  if (!u8 || u8.length < PNG_SIG.length) return false;
  for (let i = 0; i < PNG_SIG.length; i++) if (u8[i] !== PNG_SIG[i]) return false;
  return true;
}

/**
 * 大端读 u32。
 * @param {Uint8Array} u8
 * @param {number} off
 * @returns {number}
 */
function readU32(u8, off) {
  return ((u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3]) >>> 0;
}

/**
 * @param {Uint8Array} u8
 * @returns {Promise<Uint8Array<ArrayBuffer>>}
 */
async function inflateDeflate(u8) {
  if (typeof DecompressionStream !== 'function') throw new Error('当前浏览器不支持解压播放列表');
  const body = new Response(/** @type {BodyInit} */ (u8)).body;
  if (!body) throw new Error('解压流不可用');
  const stream = body.pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 从伪装 PNG 中取出 `roUd` chunk 的播放数据。
 * @param {Uint8Array} u8
 * @returns {Promise<Uint8Array>}
 */
async function unwrapRouPng(u8) {
  let n = PNG_SIG.length;
  while (n + 8 <= u8.length) {
    const len = readU32(u8, n);
    const type = readU32(u8, n + 4);
    const start = n + 8;
    if (start + len > u8.length) break;
    if (type === 0x726f5564) {
      const flag = u8[start];
      const payload = u8.subarray(start + 1, start + len);
      return (flag & 1) ? await inflateDeflate(payload) : payload;
    }
    n = start + len + 4;
  }
  throw new Error('PNG 中没有播放数据');
}

/**
 * PNG 伪装则解包，否则原样返回。
 * @param {ArrayBuffer | Uint8Array | number} buf
 * @returns {Promise<Uint8Array>}
 */
export async function unwrapIfNeeded(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(/** @type {ArrayBuffer} */ (buf || 0));
  if (looksLikePng(u8)) return await unwrapRouPng(u8);
  return u8;
}
