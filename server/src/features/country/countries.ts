// countries 表：国家字典（演员体系基石）。DDL + 全部数据操作，仅此文件触碰本表。
import { db, numOf, strOf, type SqlRow } from '../../lib/db.ts';
import type { CountryRow } from './types.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS countries (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE
  );
`);

function toRow(r: SqlRow): CountryRow {
  return { id: numOf(r.id), name: strOf(r.name) };
}

/** 全量列表（id 正序 = 添加顺序；字典表不分页不搜索）。 */
export function listCountries(): CountryRow[] {
  return (db.prepare('SELECT id, name FROM countries ORDER BY id ASC').all() as SqlRow[]).map(toRow);
}

/** 按 id 取行（女优创建/头像流取国家名用）。 */
export function getCountryById(id: number): CountryRow | null {
  const r = db.prepare('SELECT id, name FROM countries WHERE id = ?').get(id) as SqlRow | undefined;
  return r ? toRow(r) : null;
}

/** 新增：返回新行。name 已由路由层校验（trim 非空、≤60）。 */
export function insertCountry(name: string): CountryRow {
  const r = db.prepare('INSERT INTO countries (name) VALUES (?)').run(name);
  return { id: numOf(r.lastInsertRowid), name };
}

/** 改名：目标不存在返回 null（路由层转 404）。 */
export function renameCountry(id: number, name: string): CountryRow | null {
  const r = db.prepare('UPDATE countries SET name = ? WHERE id = ?').run(name, id);
  if (!numOf(r.changes)) return null;
  return { id, name };
}

/** 删除：目标不存在返回 false（路由层转 404）。被演员引用后的删除保护随演员页落地。 */
export function deleteCountry(id: number): boolean {
  return numOf(db.prepare('DELETE FROM countries WHERE id = ?').run(id).changes) > 0;
}

/** name 是否已存在（排除指定 id，改名自比对用）。 */
export function countryNameExists(name: string, excludeId = 0): boolean {
  const r = db.prepare('SELECT 1 FROM countries WHERE name = ? AND id != ?').get(name, excludeId);
  return r != null;
}
