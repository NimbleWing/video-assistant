/**
 * 十六进制字符串转字节数组。奇数长度会在开头补 '0'。
 * @param {string} hex
 * @returns {Uint8Array<ArrayBuffer>}
 */
export function hexToBytes(hex) {
  const clean = hex.length % 2 ? '0' + hex : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/**
 * HLS 未显式给出 IV 时，按规范用媒体序列号生成 16 字节 IV（大端，置于末 4 字节）。
 * @param {number} seq
 * @returns {Uint8Array<ArrayBuffer>}
 */
export function sequenceIv(seq) {
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  view.setUint32(12, seq >>> 0);
  return iv;
}

/**
 * AES-128-CBC 解密。
 * @param {BufferSource} buffer
 * @param {BufferSource} keyBytes
 * @param {BufferSource} iv
 * @returns {Promise<Uint8Array<ArrayBuffer>>}
 */
export async function decryptAes(buffer, keyBytes, iv) {
  const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, buffer);
  return new Uint8Array(plain);
}
