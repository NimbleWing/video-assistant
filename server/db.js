// 数据库层：建表 + 数据操作（node:sqlite，需 Node 22.5+ --experimental-sqlite）。
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DB_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'media.db');

export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT NOT NULL UNIQUE,
  stem       TEXT NOT NULL,
  ext        TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('video','cover')),
  size       INTEGER NOT NULL DEFAULT 0,
  mtime      INTEGER NOT NULL,
  volume     TEXT NOT NULL,
  video_id   TEXT,
  duration   REAL,
  source     TEXT NOT NULL DEFAULT 'scanned' CHECK (source IN ('scanned','recorded')),
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_stem      ON files (stem);
CREATE INDEX IF NOT EXISTS idx_files_type_stem ON files (type, stem);

CREATE TABLE IF NOT EXISTS downloads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site        TEXT NOT NULL DEFAULT 'rou.video',
  video_id    TEXT NOT NULL,
  page_path   TEXT NOT NULL,
  name        TEXT NOT NULL,
  series_name TEXT,
  quality     INTEGER,
  filename    TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('downloading','complete','failed','canceled','skipped')),
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 1,
  size        INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dl ON downloads (site, video_id);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// ---------------------------------------------------------------- 归一化与工具

/** 路径归一化：反斜杠→正斜杠、去前导斜杠、小写（Windows 大小写不敏感）。 */
/** @param {string} p @returns {string} */
export function normPath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
}

/** basename 去扩展名（去最后一个 .xxx 段），小写。 */
/** @param {string} basename @returns {string} */
export function stemOf(basename) {
  return String(basename).replace(/\.[a-z0-9]+$/i, '').toLowerCase();
}

/** 由扩展名判定媒体类型；未知返回 null。 */
/** @param {string} ext @returns {'video' | 'cover' | null} */
export function typeOfExt(ext) {
  const e = String(ext).replace(/^\./, '').toLowerCase();
  if (e === 'mp4' || e === 'ts') return 'video';
  if (e === 'jpg' || e === 'jpeg' || e === 'png' || e === 'webp') return 'cover';
  return null;
}

/** @param {string} key @returns {string | null} */
export function getMeta(key) {
  const row = /** @type {any} */ (db.prepare('SELECT value FROM meta WHERE key = ?').get(key));
  return row ? String(row.value) : null;
}

/** @param {string} key @param {string} value */
export function setMeta(key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// ---------------------------------------------------------------- files

/**
 * 扫描 upsert：按 path 唯一，文件在则只刷新 size/mtime/last_seen，
 * 绝不触碰 video_id/source（保护登记数据）。
 * @param {{ path: string, stem: string, ext: string, type: 'video' | 'cover', size: number, mtime: number, volume: string, seen: number }} f
 */
export function upsertFileScanned(f) {
  db.prepare(`
    INSERT INTO files (path, stem, ext, type, size, mtime, volume, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      size = excluded.size, mtime = excluded.mtime, last_seen = excluded.last_seen
  `).run(f.path, f.stem, f.ext, f.type, f.size, f.mtime, f.volume, f.seen, f.seen);
}

/**
 * 扩展登记 upsert：落盘成功后写入（或补全）files 行。
 * @param {{ path: string, size?: number, videoId?: string, duration?: number }} r
 */
export function upsertFileRecorded(r) {
  const p = normPath(r.path);
  const base = p.split('/').pop() || p;
  const ext = (base.match(/\.[a-z0-9]+$/i) || [''])[0].slice(1).toLowerCase();
  const type = typeOfExt(ext);
  if (!type) return;
  const now = Date.now();
  db.prepare(`
    INSERT INTO files (path, stem, ext, type, size, mtime, volume, video_id, duration, source, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      size = CASE WHEN excluded.size > 0 THEN excluded.size ELSE files.size END,
      video_id = COALESCE(excluded.video_id, files.video_id),
      duration = COALESCE(excluded.duration, files.duration),
      source = 'recorded',
      last_seen = excluded.last_seen
  `).run(p, stemOf(base), ext, type, r.size || 0, now, volumeOf(p), r.videoId ?? null, r.duration ?? null, now, now);
}

/** 盘符提取：'d:/x/y' → 'd:'；非 Windows 形态返回 '?'。 */
/** @param {string} p @returns {string} */
function volumeOf(p) {
  const m = p.match(/^([a-z]):/);
  return m ? `${m[1]}:` : '?';
}

/**
 * 去重判定：仅 type='video'；完整相对路径后缀优先、stem 相等回退。
 * @param {string} rel 完整相对路径（剧名/xx.mp4）
 * @returns {{ exists: boolean, matches: { path: string, type: string, size: number }[] }}
 */
export function queryExists(rel) {
  const r = normPath(rel);
  const stem = stemOf(r.split('/').pop() || r);
  if (!stem) return { exists: false, matches: [] };
  const rows = /** @type {any[]} */ (db.prepare(
    "SELECT path, type, size FROM files WHERE type = 'video' AND stem = ?"
  ).all(stem));
  const matches = rows
    .slice()
    .sort((a, b) => Number((/** @type {string} */ (b.path)).endsWith('/' + r)) - Number((/** @type {string} */ (a.path)).endsWith('/' + r)))
    .map((row) => ({ path: row.path, type: row.type, size: Number(row.size) || 0 }));
  return { exists: matches.length > 0, matches };
}

/** 清理消失文件：删除上次扫描后未再见到（last_seen < token）的行。 */
/** @param {number} token @returns {number} 删除行数 */
export function purgeMissing(token) {
  return Number(db.prepare('DELETE FROM files WHERE last_seen < ?').run(token).changes);
}

/**
 * 视频分页查询。
 * @param {{ page?: number, size?: number, q?: string, volume?: string, type?: string }} opt
 * @returns {{ total: number, items: any[] }}
 */
export function listVideos(opt) {
  const page = Math.max(1, Number(opt.page) || 1);
  const size = Math.min(200, Math.max(1, Number(opt.size) || 50));
  const where = [];
  const params = [];
  const type = opt.type === 'cover' ? 'cover' : 'video';
  where.push('type = ?');
  params.push(type);
  if (opt.q) {
    where.push('path LIKE ? ESCAPE \'\\\'');
    params.push(`%${String(opt.q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`.toLowerCase());
  }
  if (opt.volume) { where.push('volume = ?'); params.push(String(opt.volume).toLowerCase()); }
  const wsql = where.join(' AND ');
  const total = Number((/** @type {any} */ (db.prepare(`SELECT COUNT(*) AS n FROM files WHERE ${wsql}`).get(...params))).n) || 0;
  const items = /** @type {any[]} */ (db.prepare(
    `SELECT id, path, stem, ext, type, size, mtime, volume, video_id, duration, source, first_seen, last_seen FROM files WHERE ${wsql} ORDER BY mtime DESC, id DESC LIMIT ? OFFSET ?`
  ).all(...params, size, (page - 1) * size));
  return { total, items };
}

/** 全部盘符（页面筛选用）。 @returns {{ volume: string, videos: number }[]} */
export function listVolumes() {
  return /** @type {any[]} */ (db.prepare(
    "SELECT volume, COUNT(*) AS videos FROM files WHERE type = 'video' GROUP BY volume ORDER BY volume"
  ).all());
}

/** 库存统计（心跳端点用）。 @returns {{ videos: number, covers: number, downloads: Record<string, number> }} */
export function stats() {
  const f = /** @type {any} */ (db.prepare(
    "SELECT SUM(type = 'video') AS videos, SUM(type = 'cover') AS covers FROM files"
  ).get());
  /** @type {Record<string, number>} */
  const downloads = {};
  for (const row of /** @type {any[]} */ (db.prepare('SELECT status, COUNT(*) AS n FROM downloads GROUP BY status').all())) {
    downloads[row.status] = Number(row.n) || 0;
  }
  return { videos: Number(f?.videos) || 0, covers: Number(f?.covers) || 0, downloads };
}

/** 回填时长（列表页惰性解析后缓存，避免重复解析）。 */
/** @param {number} id @param {number} duration */
export function setFileDuration(id, duration) {
  db.prepare('UPDATE files SET duration = ? WHERE id = ?').run(duration, id);
}

// ---------------------------------------------------------------- downloads

/**
 * 下载账本 upsert（一行一视频）。
 * - status='downloading' 视为新尝试：attempts+1
 * - 可选字段缺省（NULL）时保留旧值
 * @param {{ site?: string, videoId: string, pagePath?: string, name?: string, seriesName?: string, quality?: number, filename?: string, status: string, error?: string, size?: number }} d
 */
export function upsertDownload(d) {
  const now = Date.now();
  db.prepare(`
    INSERT INTO downloads (site, video_id, page_path, name, series_name, quality, filename, status, error, attempts, size, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT(site, video_id) DO UPDATE SET
      page_path   = COALESCE(excluded.page_path, downloads.page_path),
      name        = COALESCE(excluded.name, downloads.name),
      series_name = COALESCE(excluded.series_name, downloads.series_name),
      quality     = COALESCE(excluded.quality, downloads.quality),
      filename    = COALESCE(excluded.filename, downloads.filename),
      status      = excluded.status,
      error       = excluded.error,
      attempts    = CASE WHEN excluded.status = 'downloading' THEN downloads.attempts + 1 ELSE downloads.attempts END,
      size        = COALESCE(excluded.size, downloads.size),
      updated_at  = excluded.updated_at
  `).run(
    d.site || 'rou.video', d.videoId, d.pagePath ?? '', d.name ?? d.videoId,
    d.seriesName ?? null, d.quality ?? null, d.filename ?? '', d.status,
    d.error ?? null, d.size ?? null, now, now,
  );
}

/**
 * 账本分页查询。
 * @param {{ status?: string, site?: string, q?: string, page?: number, size?: number }} opt
 * @returns {{ total: number, items: any[], counts: Record<string, number> }}
 */
export function listDownloads(opt) {
  const page = Math.max(1, Number(opt.page) || 1);
  const size = Math.min(200, Math.max(1, Number(opt.size) || 50));
  const where = [];
  const params = [];
  if (opt.status) { where.push('status = ?'); params.push(String(opt.status)); }
  if (opt.site) { where.push('site = ?'); params.push(String(opt.site)); }
  if (opt.q) {
    where.push("(name LIKE ? ESCAPE '\\' OR series_name LIKE ? ESCAPE '\\')");
    const like = `%${String(opt.q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  const wsql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = Number((/** @type {any} */ (db.prepare(`SELECT COUNT(*) AS n FROM downloads${wsql}`).get(...params))).n) || 0;
  const items = /** @type {any[]} */ (db.prepare(
    `SELECT * FROM downloads${wsql} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`
  ).all(...params, size, (page - 1) * size));
  /** @type {Record<string, number>} */
  const counts = {};
  for (const row of /** @type {any[]} */ (db.prepare('SELECT status, COUNT(*) AS n FROM downloads GROUP BY status').all())) {
    counts[row.status] = Number(row.n) || 0;
  }
  return { total, items, counts };
}
