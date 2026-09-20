// actresses / actress_aliases / actress_tags 三表：女优（演员体系核心）。
// DDL + 全部数据操作，仅此文件触碰本三表。头像 = 归档的 raw 图片（avatar_file_id → raw_files.id）。
import { db, numOf, strOf, type SqlRow } from '../../lib/db.ts';
import { actressVideoCounts } from '../video/videos.ts';
import type { ActressRow } from './types.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS actresses (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL UNIQUE,
    country_id     INTEGER NOT NULL,
    rating         INTEGER,
    disk           TEXT NOT NULL,
    avatar_file_id INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_actress_country ON actresses (country_id);

  CREATE TABLE IF NOT EXISTS actress_aliases (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    actress_id INTEGER NOT NULL,
    name       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_alias_actress ON actress_aliases (actress_id);
  CREATE INDEX IF NOT EXISTS idx_alias_name    ON actress_aliases (name);

  CREATE TABLE IF NOT EXISTS actress_tags (
    actress_id INTEGER NOT NULL,
    tag_id     INTEGER NOT NULL,
    PRIMARY KEY (actress_id, tag_id)
  );
`);

interface BaseRow {
  id: number;
  name: string;
  country_id: number;
  rating: number | null;
  disk: string;
  avatar_file_id: number | null;
}

function baseRows(): BaseRow[] {
  return (db.prepare('SELECT id, name, country_id, rating, disk, avatar_file_id FROM actresses ORDER BY id ASC').all() as SqlRow[]).map((r) => ({
    id: numOf(r.id),
    name: strOf(r.name),
    country_id: numOf(r.country_id),
    rating: r.rating == null ? null : numOf(r.rating),
    disk: strOf(r.disk),
    avatar_file_id: r.avatar_file_id == null ? null : numOf(r.avatar_file_id),
  }));
}

/**
 * 全量列表：join 出国家名 / 别名 / 标签（表量级小，两轮聚合查询后内存缝合）。
 * q 匹配主名或别名。video_count 预留恒 0（video_actresses 落地后计算）。
 */
export function listActresses(q = ''): ActressRow[] {
  const rows = baseRows();
  const aliasMap = new Map<number, string[]>();
  for (const r of db.prepare('SELECT actress_id, name FROM actress_aliases ORDER BY id ASC').all() as SqlRow[]) {
    const id = numOf(r.actress_id);
    const arr = aliasMap.get(id) ?? [];
    arr.push(strOf(r.name));
    aliasMap.set(id, arr);
  }
  const tagMap = new Map<number, ActressRow['tags']>();
  for (const r of db.prepare(
    `SELECT at.actress_id AS aid, t.id AS tid, t.name AS tname, t.sort AS tsort
     FROM actress_tags at JOIN tags t ON t.id = at.tag_id
     ORDER BY t.sort ASC, t.id ASC`,
  ).all() as SqlRow[]) {
    const aid = numOf(r.aid);
    const arr = tagMap.get(aid) ?? [];
    arr.push({ id: numOf(r.tid), name: strOf(r.tname), sort: numOf(r.tsort) });
    tagMap.set(aid, arr);
  }
  const countryNames = new Map<number, string>();
  for (const r of db.prepare('SELECT id, name FROM countries').all() as SqlRow[]) {
    countryNames.set(numOf(r.id), strOf(r.name));
  }
  const videoCounts = actressVideoCounts(); // 作品数（2026-09-21 归档流落地起真实计算）

  const needle = q.trim().toLowerCase();
  let items: ActressRow[] = rows.map((b) => ({
    ...b,
    country_name: countryNames.get(b.country_id) ?? '',
    aliases: aliasMap.get(b.id) ?? [],
    tags: tagMap.get(b.id) ?? [],
    video_count: videoCounts.get(b.id) ?? 0,
  }));
  if (needle) {
    items = items.filter((it) => it.name.toLowerCase().includes(needle) || it.aliases.some((a) => a.toLowerCase().includes(needle)));
  }
  return items;
}

/** 按 id 取完整条目（avatar 流用）。 */
export function getActress(id: number): ActressRow | null {
  const row = db.prepare('SELECT id, name, country_id, rating, disk, avatar_file_id FROM actresses WHERE id = ?').get(id) as SqlRow | undefined;
  if (!row) return null;
  const b: BaseRow = {
    id: numOf(row.id),
    name: strOf(row.name),
    country_id: numOf(row.country_id),
    rating: row.rating == null ? null : numOf(row.rating),
    disk: strOf(row.disk),
    avatar_file_id: row.avatar_file_id == null ? null : numOf(row.avatar_file_id),
  };
  return listActresses().find((it) => it.id === b.id) ?? null;
}

export interface ActressWrite {
  name: string;
  countryId: number;
  rating: number | null;
  disk: string;
  tagIds: number[];
  aliases: string[];
}

/** 创建（事务）：主行 + 别名 + 标签关联。目录创建由路由层先行完成。 */
export function insertActress(w: ActressWrite): ActressRow {
  db.exec('BEGIN');
  try {
    const r = db.prepare('INSERT INTO actresses (name, country_id, rating, disk) VALUES (?, ?, ?, ?)')
      .run(w.name, w.countryId, w.rating, w.disk);
    const id = numOf(r.lastInsertRowid);
    for (const a of w.aliases) db.prepare('INSERT INTO actress_aliases (actress_id, name) VALUES (?, ?)').run(id, a);
    for (const t of w.tagIds) db.prepare('INSERT OR IGNORE INTO actress_tags (actress_id, tag_id) VALUES (?, ?)').run(id, t);
    db.exec('COMMIT');
    return listActresses().find((it) => it.id === id) ?? emptyRow(id);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function emptyRow(id: number): ActressRow {
  return { id, name: '', country_id: 0, country_name: '', rating: null, disk: '', avatar_file_id: null, aliases: [], tags: [], video_count: 0 };
}

/** 全量编辑（事务）：name/countryId/rating + 别名/标签全量替换；disk 不可改。目标不存在返回 null。 */
export function updateActress(id: number, w: Omit<ActressWrite, 'disk'>): ActressRow | null {
  const exists = db.prepare('SELECT 1 FROM actresses WHERE id = ?').get(id) != null;
  if (!exists) return null;
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE actresses SET name = ?, country_id = ?, rating = ? WHERE id = ?').run(w.name, w.countryId, w.rating, id);
    db.prepare('DELETE FROM actress_aliases WHERE actress_id = ?').run(id);
    for (const a of w.aliases) db.prepare('INSERT INTO actress_aliases (actress_id, name) VALUES (?, ?)').run(id, a);
    db.prepare('DELETE FROM actress_tags WHERE actress_id = ?').run(id);
    for (const t of w.tagIds) db.prepare('INSERT OR IGNORE INTO actress_tags (actress_id, tag_id) VALUES (?, ?)').run(id, t);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getActress(id);
}

/** 删除：主行 + 级联清别名/标签关联。头像文件保留（归档页可见）。目标不存在返回 false。 */
export function deleteActress(id: number): boolean {
  const r = db.prepare('DELETE FROM actresses WHERE id = ?').run(id);
  if (!numOf(r.changes)) return false;
  db.prepare('DELETE FROM actress_aliases WHERE actress_id = ?').run(id);
  db.prepare('DELETE FROM actress_tags WHERE actress_id = ?').run(id);
  return true;
}

/** name 是否已存在（排除指定 id）。 */
export function actressNameExists(name: string, excludeId = 0): boolean {
  return db.prepare('SELECT 1 FROM actresses WHERE name = ? AND id != ?').get(name, excludeId) != null;
}

/** 更新头像引用（avatar 流收尾；fileId 为归档后的 raw_files.id）。 */
export function setActressAvatar(actressId: number, fileId: number): void {
  db.prepare('UPDATE actresses SET avatar_file_id = ? WHERE id = ?').run(fileId, actressId);
}

/** 标签使用计数（tag feature 的 actor_count 真实化用——放宽规则下的跨 feature 纯读）。 */
export function tagUsageCounts(): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of db.prepare('SELECT tag_id, COUNT(*) AS n FROM actress_tags GROUP BY tag_id').all() as SqlRow[]) {
    m.set(numOf(r.tag_id), numOf(r.n));
  }
  return m;
}

/** 国家是否被女优引用（country 删除保护用）。 */
export function countryInUse(countryId: number): boolean {
  return db.prepare('SELECT 1 FROM actresses WHERE country_id = ? LIMIT 1').get(countryId) != null;
}
