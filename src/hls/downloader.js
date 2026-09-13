import { Logger } from '../core/logger.js';
import { errText, isAbortError, saveBlobAs } from '../core/utils.js';
import { decryptAes } from '../core/crypto.js';
import { fetchBuffer, fetchText } from '../net/http.js';
import { parseMediaPlaylist } from './playlist.js';
import { TsRemux } from './ts-remux.js';

import { saveViaExtension } from '../net/save.js';

/**
 * @typedef {import('./playlist.js').Variant} Variant
 */

/**
 * @typedef {Object} DownloadProgress
 * @property {number} done
 * @property {number} total
 * @property {number} bytes
 * @property {number} speed B/s
 * @property {number} eta 秒
 * @property {number} pct
 * @property {boolean} [saving] 是否处于保存落盘阶段
 * @property {number} [savePct] 保存阶段进度
 */

/**
 * @typedef {Object} DownloadResult
 * @property {'downloads-api' | 'blob'} mode
 * @property {string} filename
 * @property {number} bytes
 * @property {string} [note]
 */

// 可重试的网络读取：瞬态挂起/超时重试，用户主动中止不重试
/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} [tries]
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
async function withRetry(fn, tries = 3, signal) {
  /** @type {unknown} */
  let lastErr;
  for (let i = 0; i < tries; i++) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    try {
      return await fn();
    } catch (e) {
      if (isAbortError(e)) throw e; // 用户取消
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('重试耗尽');
}

// Downloads every segment of one media playlist (decrypting if needed),
// remuxes TS → MP4 when possible, and saves the result via a blob download.
/**
 * @param {Variant} quality
 * @param {string} filename 可含子目录（经 downloads API 落盘时生效）
 * @param {(info: DownloadProgress) => void} onProgress
 * @param {AbortSignal} [signal]
 * @param {{ conflictAction?: 'uniquify' | 'overwrite' | 'prompt' }} [opts]
 * @returns {Promise<DownloadResult>}
 */
export async function downloadQuality(quality, filename, onProgress, signal, opts = {}) {
  // 播放列表与密钥请求也走重试（一次 CDN 抖动不再导致整个下载失败）
  const text = await withRetry(() => fetchText(quality.url, { signal }), 3, signal);
  const media = parseMediaPlaylist(text, quality.url);
  if (!media.segments.length) throw new Error('播放列表为空');

  /** @type {Uint8Array<ArrayBuffer> | null} */
  let keyBytes = null;
  if (media.keyUri) {
    keyBytes = new Uint8Array(await withRetry(() => fetchBuffer(media.keyUri, { signal }), 3, signal));
  }

  const total = media.segments.length;
  /** @type {Uint8Array[]} */
  const chunks = new Array(total);
  let done = 0;
  let bytes = 0;
  const started = performance.now();
  const concurrency = Math.min(6, total);
  let cursor = 0;
  let nextWrite = 0;
  /** @type {Map<number, Uint8Array>} */
  const ready = new Map();

  const fetchOne = async (/** @type {number} */ index) => {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const seg = media.segments[index];
    /** @type {unknown} */
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let buf = new Uint8Array(await fetchBuffer(seg.url, { signal }));
        if (keyBytes) buf = await decryptAes(buf, keyBytes, seg.iv);
        return buf;
      } catch (err) {
        if (isAbortError(err)) throw err; // 中止不重试
        lastErr = err;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`分段失败 ${index}`);
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
        const piece = /** @type {Uint8Array} */ (ready.get(nextWrite));
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
  // 护栏：估算过大时跳过 remux 直接存 .ts——remux 全程驻留内存，
  // 峰值约 4–5× 文件大小，GB 级视频会让标签页 OOM 崩溃（.ts 可被 VLC 等正常播放）
  const REMUX_GUARD = 1.5 * 1024 * 1024 * 1024;
  /** @type {Uint8Array[]} */
  let payload = chunks;
  let outName = filename;
  let saveNote = '';
  try {
    if (bytes > REMUX_GUARD) {
      Logger.warn('REMUX', `文件约 ${Math.round(bytes / 1073741824 * 10) / 10}GB，超出护栏，跳过 remux 直接保存 TS`);
      outName = filename.replace(/\.mp4$/i, '.ts');
      saveNote = '文件过大，已跳过 MP4 封装直接保存为 TS';
    } else if (chunks[0] && TsRemux.isMpegTs(chunks[0])) {
      const mp4 = TsRemux.remux(chunks);
      payload = [mp4];
      bytes = mp4.byteLength;
      chunks.length = 0; // 立即释放分段缓冲（大文件内存峰值减半）
    }
  } catch (err) {
    Logger.warn('REMUX', errText(err));
    outName = filename.replace(/\.mp4$/i, '.ts');
    saveNote = 'MP4 封装失败，已保存为 TS';
  }
  const mime = outName.endsWith('.ts') ? 'video/MP2T' : 'video/mp4';
  const totalBytes = payload.reduce((sum, p) => sum + p.byteLength, 0);

  // 首选扩展保存管线（downloads API 的 filename 支持子目录，剧集归目录依赖它）
  const saved = await saveViaExtension(payload, outName, mime, {
    conflictAction: opts.conflictAction,
    // 保存阶段进度透传：面板显示"保存到磁盘 x%"，大文件不再假死
    onProgress: (p) => onProgress?.({ done: total, total, bytes, speed: 0, eta: 0, pct: 99, saving: true, savePct: p.pct }),
  });
  if (saved.ok) return { mode: 'downloads-api', filename: outName, bytes: totalBytes, note: saved.note || saveNote };
  if (saved.cancelled) throw new DOMException('aborted', 'AbortError'); // 用户取消：不回退落盘

  // 回退：页面锚点下载（不支持子目录，"/" 会被替换为 "_"）
  Logger.warn('SAVE', `扩展保存失败（${saved.error}），回退锚点下载`);
  const blob = new Blob(/** @type {BlobPart[]} */ (payload), { type: mime });
  saveBlobAs(blob, outName.replace(/\//g, '_'));
  return { mode: 'blob', filename: outName, bytes: blob.size };
}
