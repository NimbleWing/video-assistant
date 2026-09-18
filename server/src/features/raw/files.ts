// raw_files 表：原始资料库（各盘 RawFiles/ 盘点 + 抽样 hash）。DDL + 全部数据操作，仅此文件触碰本表。
import { db, numOf, strOf, type SqlRow } from '../../lib/db.ts';
import type { SQLInputValue } from 'node:sqlite';
import type { RawFileRow, RawType, RawVolumeStat } from './types.ts';

/** 原始资料类型→扩展名清单（内聚本 feature，不动 lib/paths 的媒体判定）。 */
const RAW_VIDEO_EXTS = new Set(['mp4', 'ts', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', 'rm', 'rmvb']);
const RAW_IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png']);

/** 由扩展名判定原始资料类型；未知返回 null。 */
export function rawTypeOfExt(ext: string): RawType | null {
  const e = String(ext).replace(/^\./, '').toLowerCase();
  if (RAW_VIDEO_EXTS.has(e)) return 'video';
  if (RAW_IMAGE_EXTS.has(e)) return 'image';
  return null;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS raw_files (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    path            TEXT NOT NULL UNIQUE,
    hash            TEXT NOT NULL,
    name            TEXT NOT NULL,
    ext             TEXT NOT NULL,
    type            TEXT NOT NULL CHECK (type IN ('video','image')),
    size            INTEGER NOT NULL,
    mtime           INTEGER NOT NULL,
    volume          TEXT NOT NULL,
    missing         INTEGER NOT NULL DEFAULT 0,
    pending_missing INTEGER NOT NULL DEFAULT 0,
    first_seen      INTEGER NOT NULL,
    last_seen       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_raw_hash ON raw_files (hash);
`);

export interface RawScannedRow {
  path: string;
  hash: string;
  name: string;
  ext: string;
  type: RawType;
  size: number;
  mtime: number;
  volume: string;
  seen: number;
}

/** 查库中行（扫描跳过重算的三键判定用）。 */
export function findRawByPath(path: string): { size: number; mtime: number; hash: string } | null {
  const row = db.prepare('SELECT size, mtime, hash FROM raw_files WHERE path = ?').get(path) as SqlRow | undefined;
  return row ? { size: numOf(row.size), mtime: numOf(row.mtime), hash: strOf(row.hash) } : null;
}

/** 三键未变的快速通道：只刷 last_seen，missing/pending_missing 归 0（文件重现自动恢复）。 */
export function touchRawSeen(path: string, seen: number): void {
  db.prepare('UPDATE raw_files SET last_seen = ?, missing = 0, pending_missing = 0 WHERE path = ?').run(seen, path);
}

/** 扫描 upsert：按 path 唯一，更新 hash/size/mtime/last_seen 并清除消失标记。 */
export function upsertRawScanned(r: RawScannedRow): void {
  db.prepare(`
    INSERT INTO raw_files (path, hash, name, ext, type, size, mtime, volume, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      hash = excluded.hash, size = excluded.size, mtime = excluded.mtime,
      last_seen = excluded.last_seen, missing = 0, pending_missing = 0
  `).run(r.path, r.hash, r.name, r.ext, r.type, r.size, r.mtime, r.volume, r.seen, r.seen);
}

/**
 * 作用域化消失判定：对本次实际扫过且遍历成功的 (盘符, 类型) 组合，
 * last_seen < token 且 missing=0 的行置 pending_missing=1。返回标记后全部待决策数（含历史未决策）。
 */
export function markPendingMissing(scopes: { volume: string; type: RawType }[], token: number): number {
  const stmt = db.prepare(
    'UPDATE raw_files SET pending_missing = 1 WHERE volume = ? AND type = ? AND last_seen < ? AND missing = 0',
  );
  for (const s of scopes) stmt.run(s.volume, s.type, token);
  return numOf((db.prepare('SELECT COUNT(*) AS n FROM raw_files WHERE pending_missing = 1').get() as SqlRow).n);
}

export interface ListRawOpt {
  page?: number;
  size?: number;
  q?: string;
  type?: string;
  volume?: string;
  /** missing 行展示口径：hide=默认（missing=0）/ only（missing=1）/ all。 */
  missing?: string;
}

function toRow(r: SqlRow): RawFileRow {
  return {
    id: numOf(r.id),
    path: strOf(r.path),
    hash: strOf(r.hash),
    name: strOf(r.name),
    ext: strOf(r.ext),
    type: r.type === 'image' ? 'image' : 'video',
    size: numOf(r.size),
    mtime: numOf(r.mtime),
    volume: strOf(r.volume),
    missing: numOf(r.missing) === 1,
    pending_missing: numOf(r.pending_missing) === 1,
    first_seen: numOf(r.first_seen),
    last_seen: numOf(r.last_seen),
  };
}

/** 文件分页查询：名称搜索（大小写不敏感 LIKE）+ 类型/盘符/missing 筛选，最近扫到的排前面。 */
export function listRawFiles(opt: ListRawOpt): { total: number; items: RawFileRow[] } {
  const page = Math.max(1, Number(opt.page) || 1);
  const size = Math.min(200, Math.max(1, Number(opt.size) || 50));
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (opt.type === 'video' || opt.type === 'image') {
    where.push('type = ?');
    params.push(opt.type);
  }
  if (opt.volume) {
    where.push('volume = ?');
    params.push(String(opt.volume).toLowerCase());
  }
  if (opt.missing === 'only') where.push('missing = 1');
  else if (opt.missing === 'all') { /* 全部 */ }
  else where.push('missing = 0');
  if (opt.q) {
    where.push("(name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')");
    const like = `%${String(opt.q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = numOf((db.prepare(`SELECT COUNT(*) AS n FROM raw_files ${wsql}`).get(...params) as SqlRow).n);
  const items = (db.prepare(
    `SELECT id, path, hash, name, ext, type, size, mtime, volume, missing, pending_missing, first_seen, last_seen
     FROM raw_files ${wsql} ORDER BY last_seen DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...params, size, (page - 1) * size) as SqlRow[]).map(toRow);
  return { total, items };
}

/** 待决策消失清单（全量返回，量级 = 上次消失数）。 */
export function listPendingMissing(): RawFileRow[] {
  return (db.prepare(
    'SELECT id, path, hash, name, ext, type, size, mtime, volume, missing, pending_missing, first_seen, last_seen FROM raw_files WHERE pending_missing = 1 ORDER BY path',
  ).all() as SqlRow[]).map(toRow);
}

/** 批量处理全部待决策行：delete=删行；mark=置 missing=1。返回受影响行数。 */
export function resolveMissing(op: 'delete' | 'mark'): number {
  if (op === 'delete') return Number(db.prepare('DELETE FROM raw_files WHERE pending_missing = 1').run().changes);
  return Number(db.prepare('UPDATE raw_files SET missing = 1, pending_missing = 0 WHERE pending_missing = 1').run().changes);
}

/** 库内盘符统计（列表筛选用）。 */
export function rawVolumeStats(): RawVolumeStat[] {
  return (db.prepare(
    "SELECT volume, COUNT(*) AS files, SUM(type = 'video') AS videos, SUM(type = 'image') AS images FROM raw_files GROUP BY volume ORDER BY volume",
  ).all() as SqlRow[]).map((r) => ({ volume: strOf(r.volume), files: numOf(r.files), videos: numOf(r.videos), images: numOf(r.images) }));
}

/** 按 id 取行（内容端点 / HLS 适配层用）。 */
export function getRawFile(id: number): RawFileRow | null {
  const row = db.prepare(
    'SELECT id, path, hash, name, ext, type, size, mtime, volume, missing, pending_missing, first_seen, last_seen FROM raw_files WHERE id = ?',
  ).get(id) as SqlRow | undefined;
  return row ? toRow(row) : null;
}
