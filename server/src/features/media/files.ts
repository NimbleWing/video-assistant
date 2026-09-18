// files 表：磁盘实况（去重判定唯一依据）。DDL + 全部数据操作，仅此文件触碰本表。
import { db, numOf, strOf, type SqlRow } from '../../lib/db.ts';
import type { SQLInputValue } from 'node:sqlite';
import { normPath, stemOf, typeOfExt, volumeOf } from '../../lib/paths.ts';
import type { ExistsMatch, VideoItem, VolumeStat } from './types.ts';

db.exec(`
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
`);

export interface ScannedFile {
  path: string;
  stem: string;
  ext: string;
  type: 'video' | 'cover';
  size: number;
  mtime: number;
  volume: string;
  seen: number;
}

/**
 * 扫描 upsert：按 path 唯一，文件在则只刷新 size/mtime/last_seen，
 * 绝不触碰 video_id/source（保护登记数据）。
 */
export function upsertFileScanned(f: ScannedFile): void {
  db.prepare(`
    INSERT INTO files (path, stem, ext, type, size, mtime, volume, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      size = excluded.size, mtime = excluded.mtime, last_seen = excluded.last_seen
  `).run(f.path, f.stem, f.ext, f.type, f.size, f.mtime, f.volume, f.seen, f.seen);
}

/** 扩展登记 upsert：落盘成功后写入（或补全）files 行；未知扩展名静默忽略。 */
export function upsertFileRecorded(r: { path: string; size?: number; videoId?: string; duration?: number }): void {
  const p = normPath(r.path);
  const base = p.split('/').pop() ?? p;
  const ext = (base.match(/\.[a-z0-9]+$/i)?.[0] ?? '').slice(1).toLowerCase();
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
  `).run(p, stemOf(base), ext, type, r.size ?? 0, now, volumeOf(p), r.videoId ?? null, r.duration ?? null, now, now);
}

/** 清理消失文件：删除上次扫描后未再见到（last_seen < token）的行，返回删除行数。 */
export function purgeMissing(token: number): number {
  return Number(db.prepare('DELETE FROM files WHERE last_seen < ?').run(token).changes);
}

/**
 * 去重判定：仅 type='video'；完整相对路径后缀优先、stem 相等回退（matches 按此排序）。
 * @param rel 完整相对路径（剧名/xx.mp4）
 */
export function queryExists(rel: string): { exists: boolean; matches: ExistsMatch[] } {
  const r = normPath(rel);
  const stem = stemOf(r.split('/').pop() ?? r);
  if (!stem) return { exists: false, matches: [] };
  const rows = db.prepare(
    "SELECT path, type, size FROM files WHERE type = 'video' AND stem = ?",
  ).all(stem) as SqlRow[];
  const matches = rows
    .slice()
    .sort((a, b) => Number(strOf(b.path).endsWith('/' + r)) - Number(strOf(a.path).endsWith('/' + r)))
    .map((row) => ({ path: strOf(row.path), type: 'video' as const, size: numOf(row.size) }));
  return { exists: matches.length > 0, matches };
}

export interface ListVideosOpt {
  page?: number;
  size?: number;
  q?: string;
  volume?: string;
  type?: string;
}

function toVideoItem(r: SqlRow): VideoItem {
  return {
    id: numOf(r.id),
    path: strOf(r.path),
    stem: strOf(r.stem),
    ext: strOf(r.ext),
    type: r.type === 'cover' ? 'cover' : 'video',
    size: numOf(r.size),
    mtime: numOf(r.mtime),
    volume: strOf(r.volume),
    video_id: r.video_id == null ? null : String(r.video_id),
    duration: r.duration == null ? null : numOf(r.duration),
    source: r.source === 'recorded' ? 'recorded' : 'scanned',
    first_seen: numOf(r.first_seen),
    last_seen: numOf(r.last_seen),
    cover_id: null,
  };
}

/** 视频分页查询；视频条目附带封面关联 cover_id（stem 同名优先，回退所在目录名）。 */
export function listVideos(opt: ListVideosOpt): { total: number; items: VideoItem[] } {
  const page = Math.max(1, Number(opt.page) || 1);
  const size = Math.min(200, Math.max(1, Number(opt.size) || 50));
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  const type = opt.type === 'cover' ? 'cover' : 'video';
  where.push('type = ?');
  params.push(type);
  if (opt.q) {
    where.push("path LIKE ? ESCAPE '\\'");
    params.push(`%${String(opt.q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`.toLowerCase());
  }
  if (opt.volume) {
    where.push('volume = ?');
    params.push(String(opt.volume).toLowerCase());
  }
  const wsql = where.join(' AND ');
  const total = numOf((db.prepare(`SELECT COUNT(*) AS n FROM files WHERE ${wsql}`).get(...params) as SqlRow).n);
  const items = (db.prepare(
    `SELECT id, path, stem, ext, type, size, mtime, volume, video_id, duration, source, first_seen, last_seen FROM files WHERE ${wsql} ORDER BY mtime DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...params, size, (page - 1) * size) as SqlRow[]).map(toVideoItem);
  // 封面关联（管理页卡片用）：视频条目补 cover_id —— stem 同名优先（单片），回退所在目录名（剧集封面 stem=剧名）
  if (type === 'video' && items.length) {
    const stems = new Set<string>();
    for (const it of items) {
      stems.add(it.stem);
      const dirName = dirNameOf(it.path);
      if (dirName) stems.add(dirName);
    }
    const arr = [...stems];
    const rows = db.prepare(
      `SELECT id, stem FROM files WHERE type = 'cover' AND stem IN (${arr.map(() => '?').join(',')})`,
    ).all(...arr) as SqlRow[];
    const byStem = new Map<string, number>();
    for (const r of rows) if (!byStem.has(strOf(r.stem))) byStem.set(strOf(r.stem), numOf(r.id));
    for (const it of items) {
      const dirName = dirNameOf(it.path);
      it.cover_id = byStem.get(it.stem) ?? (dirName ? (byStem.get(dirName) ?? null) : null);
    }
  }
  return { total, items };
}

/** 'g:/肉视频/剧名/xx.mp4' → '剧名'（无目录返回空串）。 */
function dirNameOf(p: string): string {
  const slash = p.lastIndexOf('/');
  const dir = slash > 0 ? p.slice(0, slash) : '';
  return dir.slice(dir.lastIndexOf('/') + 1);
}

/** 全部盘符（页面筛选用）。 */
export function listVolumes(): VolumeStat[] {
  return (db.prepare(
    "SELECT volume, COUNT(*) AS videos FROM files WHERE type = 'video' GROUP BY volume ORDER BY volume",
  ).all() as SqlRow[]).map((r) => ({ volume: strOf(r.volume), videos: numOf(r.videos) }));
}

/** 媒体库存量统计（/api/ping 聚合用）。 */
export function mediaStats(): { videos: number; covers: number } {
  const f = db.prepare(
    "SELECT SUM(type = 'video') AS videos, SUM(type = 'cover') AS covers FROM files",
  ).get() as SqlRow;
  return { videos: numOf(f?.videos), covers: numOf(f?.covers) };
}

/** 回填时长（列表页惰性解析后缓存，避免重复解析）。 */
export function setFileDuration(id: number, duration: number): void {
  db.prepare('UPDATE files SET duration = ? WHERE id = ?').run(duration, id);
}

/** 流播放取文件基础信息（库中 size 可能滞后，实盘 stat 为准；type/duration 供 HLS 会话用）。 */
export function getFileBasic(id: number): { path: string; size: number; ext: string; type: 'video' | 'cover'; duration: number | null } | null {
  const row = db.prepare('SELECT path, size, ext, type, duration FROM files WHERE id = ?').get(id) as SqlRow | undefined;
  return row
    ? { path: strOf(row.path), size: numOf(row.size), ext: strOf(row.ext), type: row.type === 'cover' ? 'cover' : 'video', duration: row.duration == null ? null : numOf(row.duration) }
    : null;
}
