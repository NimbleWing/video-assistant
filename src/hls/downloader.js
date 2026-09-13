import { Logger } from '../core/logger.js';
import { isAbortError } from '../core/utils.js';
import { decryptAes } from '../core/crypto.js';
import { fetchBuffer, fetchText } from '../net/http.js';
import { parseMediaPlaylist } from './playlist.js';
import { openSaveSession } from '../net/save.js';

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
 * @property {'fs' | 'skip'} mode
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

/**
 * 流式下载一个清晰度的全部分段：页面侧解密后按序发往 offscreen（remux+写盘）。
 * 分段不落内存全量——发送窗口背压，内存峰值 ≈ 并发窗口而非整文件。
 * 指纹 = 播放列表地址+分段数+首尾分段地址，断点续传凭它防止串片。
 * @param {Variant} quality
 * @param {string} filename provisional 名（.mp4 结尾，可含子目录）
 * @param {(info: DownloadProgress) => void} onProgress
 * @param {AbortSignal} [signal]
 * @param {{ conflictAction?: 'uniquify' | 'overwrite' | 'prompt' }} [opts] 已废弃（保留兼容）
 * @returns {Promise<DownloadResult>}
 */
export async function downloadQuality(quality, filename, onProgress, signal, opts = {}) {
  void opts;
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
  const fingerprint = `${quality.url}|${total}|${media.segments[0].url}|${media.segments[total - 1].url}`;

  const begin = await openSaveSession({ filename, fingerprint, segTotal: total });
  if (begin.done) return { mode: 'skip', filename, bytes: 0, note: '本地已存在' };
  if (!begin.ok || !begin.session) {
    const e = /** @type {Error & { code?: string }} */ (new Error(begin.error || '保存通道不可用'));
    if (begin.code) e.code = begin.code;
    throw e;
  }
  const session = begin.session;
  const resumeFrom = begin.resumeFrom || 0;
  if (resumeFrom > 0) Logger.info('DL', `从第 ${resumeFrom + 1}/${total} 段断点续传`);

  let done = resumeFrom;
  let bytes = 0;
  const started = performance.now();
  const concurrency = Math.min(6, Math.max(1, total - resumeFrom));
  let cursor = resumeFrom;
  let nextWrite = resumeFrom;
  /** @type {Map<number, Uint8Array>} */
  const ready = new Map();
  /** @type {unknown} */
  let workerErr = null;
  // 背压窗口：未确认分段上限（≈ 并发在飞 + 发送缓冲），页面内存峰值的闸门
  const WINDOW = concurrency + 18;

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
    const remain = done > resumeFrom ? ((total - done) * (elapsed / (done - resumeFrom))) : 0;
    onProgress({ done, total, bytes, speed, eta: remain, pct: total ? (done / total) * 100 : 0 });
  };

  const workers = Array.from({ length: concurrency }, async () => {
    while (!workerErr) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      while (cursor - nextWrite >= WINDOW && !workerErr) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        await new Promise((r) => setTimeout(r, 50));
      }
      const index = cursor;
      cursor++;
      if (index >= total) return;
      const buf = await fetchOne(index);
      ready.set(index, buf);
    }
  }).map((p) => p.catch((e) => { if (!workerErr) workerErr = e; }));

  try {
    while (nextWrite < total) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      if (workerErr) throw workerErr;
      const buf = ready.get(nextWrite);
      if (!buf) {
        await new Promise((r) => setTimeout(r, 20));
        continue;
      }
      ready.delete(nextWrite);
      await session.write(buf); // ACK 背压：offscreen 落盘慢会自然拖住下载
      bytes += buf.byteLength;
      done++;
      nextWrite++;
      report();
    }
    await Promise.all(workers);
    if (workerErr) throw workerErr;
    const fin = await session.finalize();
    if (!fin.ok) {
      const e = /** @type {Error & { code?: string }} */ (new Error(fin.error || '保存收尾失败'));
      if (fin.code) e.code = fin.code;
      throw e;
    }
    return {
      mode: 'fs',
      filename: fin.finalName,
      bytes,
      note: (resumeFrom > 0 ? `断点续传完成（自第 ${resumeFrom + 1} 段）。` : '') + (fin.note || ''),
    };
  } catch (e) {
    // 取消/失败：中止会话但保留 .part+sidecar，重试自动续传
    await session.abort();
    throw e;
  }
}
