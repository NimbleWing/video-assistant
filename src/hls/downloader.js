import { Logger } from '../core/logger.js';
import { saveBlobAs } from '../core/utils.js';
import { decryptAes } from '../core/crypto.js';
import { fetchBuffer, fetchText } from '../net/http.js';
import { parseMediaPlaylist } from './playlist.js';
import { TsRemux } from './ts-remux.js';

// Downloads every segment of one media playlist (decrypting if needed),
// remuxes TS → MP4 when possible, and saves the result via a blob download.
export async function downloadQuality(quality, filename, onProgress, signal) {
  const text = await fetchText(quality.url, { signal });
  const media = parseMediaPlaylist(text, quality.url);
  if (!media.segments.length) throw new Error('播放列表为空');

  let keyBytes = null;
  if (media.keyUri) {
    keyBytes = new Uint8Array(await fetchBuffer(media.keyUri, { signal }));
  }

  const total = media.segments.length;
  const chunks = new Array(total);
  let done = 0;
  let bytes = 0;
  const started = performance.now();
  const concurrency = Math.min(6, total);
  let cursor = 0;
  let nextWrite = 0;
  const ready = new Map();

  const fetchOne = async (index) => {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const seg = media.segments[index];
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let buf = new Uint8Array(await fetchBuffer(seg.url, { signal }));
        if (keyBytes) buf = await decryptAes(buf, keyBytes, seg.iv);
        return buf;
      } catch (err) {
        if (err?.name === 'AbortError') throw err; // 中止不重试
        lastErr = err;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw lastErr || new Error(`分段失败 ${index}`);
  };

  const report = () => {
    const elapsed = (performance.now() - started) / 1000;
    const speed = elapsed > 0 ? bytes / elapsed : 0;
    const remain = done > 0 ? ((total - done) * (elapsed / done)) : 0;
    onProgress({ done, total, bytes, speed, eta: remain, pct: total ? (done / total) * 100 : 0 });
  };

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const index = cursor;
      cursor++;
      if (index >= total) return;
      const buf = await fetchOne(index);
      ready.set(index, buf);
      while (ready.has(nextWrite)) {
        const piece = ready.get(nextWrite);
        ready.delete(nextWrite);
        bytes += piece.byteLength;
        chunks[nextWrite] = piece;
        nextWrite++;
        done++;
        report();
      }
    }
  });

  await Promise.all(workers);
  onProgress({ done: total, total, bytes, speed: 0, eta: 0, pct: 99 });
  let payload = chunks;
  let outName = filename;
  try {
    if (chunks[0] && TsRemux.isMpegTs(chunks[0])) {
      const mp4 = TsRemux.remux(chunks);
      payload = [mp4];
      bytes = mp4.byteLength;
    }
  } catch (err) {
    Logger.warn('REMUX', err && err.message ? err.message : err);
    outName = filename.replace(/\.mp4$/i, '.ts');
  }
  const blob = new Blob(payload, { type: outName.endsWith('.ts') ? 'video/MP2T' : 'video/mp4' });
  const url = saveBlobAs(blob, outName);
  return { mode: 'blob', blobUrl: url, filename: outName, bytes: blob.size };
}
