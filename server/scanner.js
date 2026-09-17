// 磁盘扫描：全量遍历 + 增量写 + 清失（幂等）。范围由 meta.scan_dirs 配置。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getMeta, normPath, stemOf, typeOfExt, upsertFileScanned, purgeMissing } from './db.js';

/** @type {Promise<ScanResult> | null} 防并发 */
let running = null;

/**
 * @typedef {Object} ScanResult
 * @property {number} videos
 * @property {number} covers
 * @property {number} removed
 * @property {string[]} warnings
 * @property {number} ms
 */

/** 读取扫描目录配置。 @returns {string[]} */
export function scanDirs() {
  try {
    const v = JSON.parse(getMeta('scan_dirs') || '[]');
    return Array.isArray(v) ? v.map((s) => String(s)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * 执行一次扫描（进行中则复用同一 Promise）。
 * last_seen 统一使用本次扫描 token：结束后删除 last_seen < token 的行；
 * 扫描期间通过 /api/files 登记的新行 last_seen = now > token，不会被误删。
 * @returns {Promise<ScanResult>}
 */
export function scanAll() {
  if (running) return running;
  running = scanInner().finally(() => { running = null; });
  return running;
}

/** @returns {Promise<ScanResult>} */
async function scanInner() {
  const t0 = Date.now();
  const token = t0;
  const dirs = scanDirs();
  /** @type {ScanResult} */
  const result = { videos: 0, covers: 0, removed: 0, warnings: [], ms: 0 };
  if (!dirs.length) {
    result.warnings.push('未配置扫描目录（请在设置页添加）');
    result.ms = Date.now() - t0;
    return result;
  }
  for (const dir of dirs) {
    try {
      const files = await collect(dir);
      for (const f of files) {
        const type = typeOfExt(f.ext);
        if (!type) continue;
        // Windows 的 path.relative/basename 返回反斜杠分隔，basename 取文件名必须兼容
        const base = f.rel.replace(/\\/g, '/').split('/').pop() || f.rel;
        upsertFileScanned({
          path: normPath(f.abs),
          stem: stemOf(base),
          ext: f.ext,
          type,
          size: f.size,
          mtime: f.mtimeMs,
          volume: volumeOf(f.abs),
          seen: token,
        });
        if (type === 'video') result.videos += 1; else result.covers += 1;
      }
    } catch (e) {
      result.warnings.push(`${dir}: ${/** @type {Error} */ (e).message}`);
    }
  }
  result.removed = purgeMissing(token);
  result.ms = Date.now() - t0;
  return result;
}

/** @param {string} absPath @returns {string} */
function volumeOf(absPath) {
  const m = absPath.match(/^([A-Za-z]):/);
  return m ? `${m[1].toLowerCase()}:` : '?';
}

/**
 * 递归收集目录下全部文件（含 stat 信息）。
 * @param {string} root
 * @returns {Promise<{ abs: string, rel: string, ext: string, size: number, mtimeMs: number }[]>}
 */
async function collect(root) {
  const out = [];
  const stack = [path.resolve(root)];
  while (stack.length) {
    const dir = /** @type {string} */ (stack.pop());
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限/已消失的子目录：跳过（根目录失败由外层捕获）
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).slice(1).toLowerCase();
      if (!typeOfExt(ext)) continue;
      try {
        const st = await fs.stat(abs);
        out.push({ abs, rel: path.relative(path.resolve(root), abs), ext, size: st.size, mtimeMs: Math.round(st.mtimeMs) });
      } catch { /* 文件在枚举与 stat 之间消失：忽略 */ }
    }
  }
  return out;
}
