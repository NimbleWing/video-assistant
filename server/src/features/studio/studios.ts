// studios 表：片商字典（logo BLOB 入库）。DDL + 全部数据操作，仅此文件触碰本表。
import { db, numOf, strOf, type SqlRow } from '../../lib/db.ts';
import type { StudioRow } from './types.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS studios (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL UNIQUE,
    logo      BLOB,
    logo_type TEXT
  );
`);

function toRow(r: SqlRow): StudioRow {
  // video_count / actor_count 预留：视频→片商关联落地后由 JOIN 计算
  // （actor_count = 片商视频关联演员的去重数）
  return {
    id: numOf(r.id),
    name: strOf(r.name),
    has_logo: r.has_logo === 1,
    video_count: 0,
    actor_count: 0,
  };
}

/** 全量列表（id 正序 = 添加顺序；不回 logo 字节，条目含 has_logo）。 */
export function listStudios(): StudioRow[] {
  return (db.prepare(
    'SELECT id, name, (logo IS NOT NULL) AS has_logo FROM studios ORDER BY id ASC',
  ).all() as SqlRow[]).map(toRow);
}

/** 新增：返回新行（无 logo）。name 已由路由层校验。 */
export function insertStudio(name: string): StudioRow {
  const r = db.prepare('INSERT INTO studios (name) VALUES (?)').run(name);
  return { id: numOf(r.lastInsertRowid), name, has_logo: false, video_count: 0, actor_count: 0 };
}

/** 改名：目标不存在返回 null（路由层转 404）。 */
export function renameStudio(id: number, name: string): StudioRow | null {
  const r = db.prepare('UPDATE studios SET name = ? WHERE id = ?').run(name, id);
  if (!numOf(r.changes)) return null;
  const row = db.prepare('SELECT id, name, (logo IS NOT NULL) AS has_logo FROM studios WHERE id = ?').get(id) as SqlRow | undefined;
  return row ? toRow(row) : null;
}

/** 删除：目标不存在返回 false（logo 随行删除）。被引用后的删除保护随关联落地。 */
export function deleteStudio(id: number): boolean {
  return numOf(db.prepare('DELETE FROM studios WHERE id = ?').run(id).changes) > 0;
}

/** name 是否已存在（排除指定 id，改名自比对用）。 */
export function studioNameExists(name: string, excludeId = 0): boolean {
  const r = db.prepare('SELECT 1 FROM studios WHERE name = ? AND id != ?').get(name, excludeId);
  return r != null;
}

/** id 是否存在。 */
export function studioExists(id: number): boolean {
  return db.prepare('SELECT 1 FROM studios WHERE id = ?').get(id) != null;
}

/** 设置/替换 logo（字节 + MIME；调用方已完成魔数与大小校验），返回最新行。 */
export function setStudioLogo(id: number, logo: Uint8Array, logoType: string): StudioRow {
  db.prepare('UPDATE studios SET logo = ?, logo_type = ? WHERE id = ?').run(logo, logoType, id);
  const row = db.prepare('SELECT id, name, (logo IS NOT NULL) AS has_logo FROM studios WHERE id = ?').get(id) as SqlRow | undefined;
  return row ? toRow(row) : { id, name: '', has_logo: true, video_count: 0, actor_count: 0 };
}

/** 清除 logo（置 NULL；先经 studioExists 判存在）。 */
export function clearStudioLogo(id: number): void {
  db.prepare('UPDATE studios SET logo = NULL, logo_type = NULL WHERE id = ?').run(id);
}

/** 取 logo 字节与 MIME；无 logo 或行不存在返回 null。 */
export function getStudioLogo(id: number): { logo: Uint8Array; logoType: string } | null {
  const row = db.prepare('SELECT logo, logo_type FROM studios WHERE id = ?').get(id) as SqlRow | undefined;
  if (!row || row.logo == null) return null;
  return { logo: row.logo as Uint8Array, logoType: strOf(row.logo_type) || 'application/octet-stream' };
}
