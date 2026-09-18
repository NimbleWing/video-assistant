// downloads 表：下载账本（一行一视频）。DDL + 全部数据操作，仅此文件触碰本表。
import { db, numOf, strOf, type SqlRow } from '../../lib/db.ts';
import type { SQLInputValue } from 'node:sqlite';
import type { DownloadRow, DownloadUpsertRequest } from './types.ts';

db.exec(`
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
`);

/**
 * 账本 upsert（一行一视频）：
 * - status='downloading' 视为新尝试：attempts+1
 * - 可选字段缺省（NULL）时保留旧值
 */
export function upsertDownload(d: DownloadUpsertRequest): void {
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

function toDownloadRow(r: SqlRow): DownloadRow {
  return {
    id: numOf(r.id),
    site: strOf(r.site),
    video_id: strOf(r.video_id),
    page_path: strOf(r.page_path),
    name: strOf(r.name),
    series_name: r.series_name == null ? null : String(r.series_name),
    quality: r.quality == null ? null : numOf(r.quality),
    filename: strOf(r.filename),
    status: strOf(r.status) as DownloadRow['status'], // CHECK 约束保证合法
    error: r.error == null ? null : String(r.error),
    attempts: numOf(r.attempts, 1),
    size: r.size == null ? null : numOf(r.size),
    created_at: numOf(r.created_at),
    updated_at: numOf(r.updated_at),
  };
}

/** 账本分页查询（附各 status 计数）。 */
export function listDownloads(opt: { status?: string; site?: string; q?: string; page?: number; size?: number }): {
  total: number;
  items: DownloadRow[];
  counts: Record<string, number>;
} {
  const page = Math.max(1, Number(opt.page) || 1);
  const size = Math.min(200, Math.max(1, Number(opt.size) || 50));
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (opt.status) {
    where.push('status = ?');
    params.push(String(opt.status));
  }
  if (opt.site) {
    where.push('site = ?');
    params.push(String(opt.site));
  }
  if (opt.q) {
    where.push("(name LIKE ? ESCAPE '\\' OR series_name LIKE ? ESCAPE '\\')");
    const like = `%${String(opt.q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  const wsql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = numOf((db.prepare(`SELECT COUNT(*) AS n FROM downloads${wsql}`).get(...params) as SqlRow).n);
  const items = (db.prepare(
    `SELECT * FROM downloads${wsql} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...params, size, (page - 1) * size) as SqlRow[]).map(toDownloadRow);
  return { total, items, counts: dlStatusCounts() };
}

/** 各 status 计数（/api/ping 聚合与账本页 chips 共用）。 */
export function dlStatusCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of db.prepare('SELECT status, COUNT(*) AS n FROM downloads GROUP BY status').all() as SqlRow[]) {
    counts[strOf(row.status)] = numOf(row.n);
  }
  return counts;
}
