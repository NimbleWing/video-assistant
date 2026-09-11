// Site wraps HLS playlists in a 1x1 PNG with a custom `roUd` chunk
// (flag&1 = zlib deflate). This module unwraps that disguise.
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function looksLikePng(u8) {
  if (!u8 || u8.length < PNG_SIG.length) return false;
  for (let i = 0; i < PNG_SIG.length; i++) if (u8[i] !== PNG_SIG[i]) return false;
  return true;
}

function readU32(u8, off) {
  return ((u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3]) >>> 0;
}

async function inflateDeflate(u8) {
  if (typeof DecompressionStream !== 'function') throw new Error('当前浏览器不支持解压播放列表');
  const stream = new Response(u8).body.pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

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

export async function unwrapIfNeeded(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf || 0);
  if (looksLikePng(u8)) return await unwrapRouPng(u8);
  return u8;
}
