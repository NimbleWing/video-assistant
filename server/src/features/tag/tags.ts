// tags 表：标签字典（sort 拖拽排序）。DDL + 全部数据操作，仅此文件触碰本表。
import { db, numOf, strOf, type SqlRow } from '../../lib/db.ts';
import { tagUsageCounts } from '../actress/actresses.ts';
import type { TagRow } from './types.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS tags (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort INTEGER NOT NULL
  );
`);

function toRow(r: SqlRow, usage: Map<number, number>): TagRow {
  // video_count 预留：video_tags 落地后 JOIN 计算；actor_count = 挂此标签的女优数（真实）
  return { id: numOf(r.id), name: strOf(r.name), sort: numOf(r.sort), video_count: 0, actor_count: usage.get(numOf(r.id)) ?? 0 };
}

/** 全量列表（sort 升序、id 兜底稳定；字典表不分页不搜索）。 */
export function listTags(): TagRow[] {
  const usage = tagUsageCounts();
  return (db.prepare('SELECT id, name, sort FROM tags ORDER BY sort ASC, id ASC').all() as SqlRow[]).map((r) => toRow(r, usage));
}

/** 新增：追加末尾（sort = max+1）。name 已由路由层校验。 */
export function insertTag(name: string): TagRow {
  const max = numOf((db.prepare('SELECT MAX(sort) AS m FROM tags').get() as SqlRow).m);
  const r = db.prepare('INSERT INTO tags (name, sort) VALUES (?, ?)').run(name, max + 1);
  return { id: numOf(r.lastInsertRowid), name, sort: max + 1, video_count: 0, actor_count: 0 };
}

/** 改名：目标不存在返回 null（路由层转 404）。 */
export function renameTag(id: number, name: string): TagRow | null {
  const r = db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name, id);
  if (!numOf(r.changes)) return null;
  const usage = tagUsageCounts();
  const row = db.prepare('SELECT id, name, sort FROM tags WHERE id = ?').get(id) as SqlRow | undefined;
  return row ? toRow(row, usage) : null;
}

/** 删除：目标不存在返回 false（路由层转 404）。被引用后的删除保护随关联表落地。 */
export function deleteTag(id: number): boolean {
  return numOf(db.prepare('DELETE FROM tags WHERE id = ?').run(id).changes) > 0;
}

/** name 是否已存在（排除指定 id，改名自比对用）。 */
export function tagNameExists(name: string, excludeId = 0): boolean {
  const r = db.prepare('SELECT 1 FROM tags WHERE name = ? AND id != ?').get(name, excludeId);
  return r != null;
}

/**
 * 拖拽排序落库：按给定 id 顺序全量重编号 sort=1..n（紧凑连续，事务保证一致性）。
 * 不存在的 id 忽略（并发删除场景）；未出现在 ids 中的行排到末尾（按现有 sort 稳定续编）。
 */
export function reorderTags(ids: number[]): void {
  db.exec('BEGIN');
  try {
    let i = 0;
    for (const id of ids) {
      const r = db.prepare('UPDATE tags SET sort = ? WHERE id = ?').run(i + 1, id);
      if (numOf(r.changes)) i++; // 行存在才占编号；不存在（并发删除）静默忽略
    }
    // 未携带的行（并发新增等）按现有顺序续编到末尾，保持 sort 紧凑
    const rest = db.prepare('SELECT id FROM tags ORDER BY sort ASC, id ASC').all() as SqlRow[];
    for (const row of rest) {
      const id = numOf(row.id);
      if (ids.includes(id)) continue;
      i++;
      db.prepare('UPDATE tags SET sort = ? WHERE id = ?').run(i, id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
