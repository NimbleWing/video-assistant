// raw_files 表：原始资料库（各盘 RawFiles/ 盘点 + 抽样 hash）。DDL + 全部数据操作，仅此文件触碰本表。
import { promises as fs } from 'node:fs';
import { db, numOf, strOf, type SqlRow } from '../../lib/db.ts';
import { normPath, stemOf, volumeOf } from '../../lib/paths.ts';
import type { SQLInputValue } from 'node:sqlite';
import type { ArchivedItem, RawDupGroup, RawEventItem, RawFileRow, RawType, RawVolumeStat } from './types.ts';

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
    archived        INTEGER NOT NULL DEFAULT 0,
    first_seen      INTEGER NOT NULL,
    last_seen       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_raw_hash ON raw_files (hash);
`);
// 旧库迁移：P6 建的表没有 archived 列（列已存在时 ALTER 报 duplicate column，吞掉即可）
try {
  db.exec('ALTER TABLE raw_files ADD archived INTEGER NOT NULL DEFAULT 0');
} catch {
  /* 列已存在 */
}

db.exec(`
  CREATE TABLE IF NOT EXISTS raw_archive (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id    INTEGER NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS raw_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id    INTEGER NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('rename','move')),
    result     TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_raw_events_file ON raw_events (file_id, created_at);
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
 * 判定链 raw 层（/api/exists 第三层）：stem 相等的现存视频行。
 * 匹配最初名（name，改名不更新）或最新名（raw_archive.name）——两者指向盘上同一物理文件；
 * missing/pending_missing 行排除（文件可能已不在盘上，与查重「仅现存行」口径一致）。
 * 判定边界 = 本地物理存在，与来源站点无关（多站点同名视频靠 stem 归一化覆盖）。
 * @param rel 完整相对路径（取 basename 的 stem，归一化小写）
 */
export function rawVideoMatches(rel: string): { path: string; size: number }[] {
  const normalized = normPath(rel);
  const stem = stemOf(normalized.split('/').pop() ?? normalized);
  if (!stem) return [];
  const rows = db.prepare(`
    SELECT f.path, f.size FROM raw_files f
    LEFT JOIN raw_archive a ON a.file_id = f.id
    WHERE f.type = 'video' AND f.missing = 0 AND f.pending_missing = 0
      AND (LOWER(f.name) = ? OR LOWER(a.name) = ?)
  `).all(stem, stem) as SqlRow[];
  return rows.map((row) => ({ path: strOf(row.path), size: numOf(row.size) }));
}

/**
 * 作用域化消失判定：对本次实际扫过且遍历成功的每个 (扫描根, 类型) 组合，
 * 行在扫描根内（路径前缀匹配）且 last_seen < token 且 missing=0 → 置 pending_missing=1。
 * **根外豁免（2026-09-21）**：行路径不在任何扫描根内（如头像移入 Archives、手动移出
 * RawFiles 的策展文件）不判——扫描对它们本就无从「看见」。范围内归档行照判
 * （RawFiles 内移动/改名仍走配对或待决策原语义）。返回标记后全部待决策数（含历史未决策）。
 */
export function markPendingMissing(scopes: { volume: string; root: string; type: RawType }[], token: number): number {
  const stmt = db.prepare(
    `UPDATE raw_files SET pending_missing = 1
     WHERE volume = ? AND type = ? AND last_seen < ? AND missing = 0
       AND substr(path, 1, ?) = ?`,
  );
  for (const s of scopes) stmt.run(s.volume, s.type, token, s.root.length, s.root);
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
  /** 归档行展示口径：hide=默认（archived=0，仅未归档）/ only（仅已归档）/ all。 */
  archived?: string;
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
    archived: numOf(r.archived) === 1,
    first_seen: numOf(r.first_seen),
    last_seen: numOf(r.last_seen),
  };
}

/** 按 path 取完整行（配对时由扫描器调用）。 */
export function getRawByPath(path: string): RawFileRow | null {
  const row = db.prepare(
    'SELECT id, path, hash, name, ext, type, size, mtime, volume, missing, pending_missing, archived, first_seen, last_seen FROM raw_files WHERE path = ?',
  ).get(path) as SqlRow | undefined;
  return row ? toRow(row) : null;
}

/** 文件分页查询：名称搜索（大小写不敏感 LIKE）+ 类型/盘符/missing/归档状态筛选，最近扫到的排前面。 */
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
  // 归档状态：hide（默认）= 仅未归档（归档行在归档资料页有专属视图）；only = 仅已归档；all = 全部
  if (opt.archived === 'only') where.push('archived = 1');
  else if (opt.archived === 'all') { /* 全部 */ }
  else where.push('archived = 0');
  if (opt.q) {
    where.push("(name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')");
    const like = `%${String(opt.q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = numOf((db.prepare(`SELECT COUNT(*) AS n FROM raw_files ${wsql}`).get(...params) as SqlRow).n);
  const items = (db.prepare(
    `SELECT id, path, hash, name, ext, type, size, mtime, volume, missing, pending_missing, archived, first_seen, last_seen
     FROM raw_files ${wsql} ORDER BY last_seen DESC, id DESC LIMIT ? OFFSET ?`,
  ).all(...params, size, (page - 1) * size) as SqlRow[]).map(toRow);
  return { total, items };
}

/** 待决策消失清单（全量返回，量级 = 上次消失数）。 */
export function listPendingMissing(): RawFileRow[] {
  return (db.prepare(
    'SELECT id, path, hash, name, ext, type, size, mtime, volume, missing, pending_missing, archived, first_seen, last_seen FROM raw_files WHERE pending_missing = 1 ORDER BY path',
  ).all() as SqlRow[]).map(toRow);
}

/**
 * 文件查重：按抽样 hash 聚合现存行（missing=0 且 pending_missing=0），≥2 份成组；
 * 组按冗余空间降序分页，附全库组数与重复占用总量。零字节文件排除（hash 输入仅 size，
 * 全部 0 B 文件同指纹互聚成假组——失败下载的垃圾文件，非重复）。
 */
export function listRawDuplicates(opt: { page?: number; size?: number }): {
  total: number;
  wastedTotal: number;
  items: RawDupGroup[];
} {
  const page = Math.max(1, Number(opt.page) || 1);
  const size = Math.min(50, Math.max(1, Number(opt.size) || 20));
  const live = 'missing = 0 AND pending_missing = 0 AND size > 0';
  const agg = `SELECT hash, COUNT(*) AS cnt, MIN(size) AS size FROM raw_files
               WHERE ${live} GROUP BY hash HAVING COUNT(*) >= 2`;
  const summary = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM((cnt - 1) * size), 0) AS wasted FROM (${agg})`).get() as SqlRow;
  const hashes = (db.prepare(`${agg} ORDER BY (cnt - 1) * size DESC, hash LIMIT ? OFFSET ?`)
    .all(size, (page - 1) * size) as SqlRow[]).map((r) => strOf(r.hash));
  const items: RawDupGroup[] = [];
  if (hashes.length) {
    const byHash = new Map<string, RawFileRow[]>();
    for (const r of db.prepare(
      `SELECT id, path, hash, name, ext, type, size, mtime, volume, missing, pending_missing, archived, first_seen, last_seen
       FROM raw_files WHERE ${live}
       AND hash IN (${hashes.map(() => '?').join(',')}) ORDER BY path`,
    ).all(...hashes) as SqlRow[]) {
      const row = toRow(r);
      const arr = byHash.get(row.hash) ?? [];
      arr.push(row);
      byHash.set(row.hash, arr);
    }
    for (const h of hashes) {
      const files = byHash.get(h) ?? [];
      if (files.length < 2) continue;
      const first = files[0] as RawFileRow;
      items.push({ hash: h, count: files.length, size: first.size, type: first.type, wasted: (files.length - 1) * first.size, files });
    }
  }
  return { total: numOf(summary.n), wastedTotal: numOf(summary.wasted), items };
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
    'SELECT id, path, hash, name, ext, type, size, mtime, volume, missing, pending_missing, archived, first_seen, last_seen FROM raw_files WHERE id = ?',
  ).get(id) as SqlRow | undefined;
  return row ? toRow(row) : null;
}

/**
 * 删除单个物理文件及其行（查重清理）：unlink 磁盘文件（ENOENT 视为已删）后删行；
 * unlink 其他失败（占用/权限）抛错且保留行。调用方负责 RawFiles 前缀护栏。
 * raw_archive/raw_events 悬空保留（对齐 resolveMissing 删行语义）。
 */
export async function deleteRawPhysical(id: number): Promise<{ fileDeleted: boolean } | null> {
  const row = getRawFile(id);
  if (!row) return null;
  let fileDeleted = false;
  try {
    await fs.unlink(row.path);
    fileDeleted = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`删除文件失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  db.prepare('DELETE FROM raw_files WHERE id = ?').run(id);
  return { fileDeleted };
}

/**
 * 手动归档到指定路径（女优头像流）：物理移动（同盘 rename，跨盘 copy+unlink）
 * → 行跟随新路径并置 archived=1（真·归档语义，归档页持续可见）
 * → raw_archive upsert 最新名 → raw_events 按需记 rename/move（对齐 mergeMove 事件格式）。
 * DB 失败时尝试把文件移回原位。返回更新后的行。
 */
export async function archiveRawFileTo(id: number, newPath: string): Promise<RawFileRow | null> {
  const row = getRawFile(id);
  if (!row) return null;
  const target = normPath(newPath);
  const oldBase = row.path.slice(row.path.lastIndexOf('/') + 1);
  const newBase = target.slice(target.lastIndexOf('/') + 1);
  const oldDir = row.path.slice(0, row.path.lastIndexOf('/'));
  const newDir = target.slice(0, target.lastIndexOf('/'));
  const now = Date.now();

  await fs.mkdir(newDir, { recursive: true });
  const moved = async (from: string, to: string) => {
    try {
      await fs.rename(from, to);
    } catch {
      await fs.copyFile(from, to);
      await fs.unlink(from);
    }
  };
  await moved(row.path, target);
  try {
    const st = await fs.stat(target);
    db.exec('BEGIN');
    try {
      db.prepare(
        `UPDATE raw_files SET path = ?, volume = ?, size = ?, mtime = ?, archived = 1,
         missing = 0, pending_missing = 0, last_seen = ? WHERE id = ?`,
      ).run(target, volumeOf(target), st.size, Math.round(st.mtimeMs), now, id);
      // raw_archive.name = 最新名去扩展名（对齐扫描器约定：name 列存去 ext 的 basename）
      const newName = newBase.replace(/\.[a-z0-9]+$/i, '') || newBase;
      db.prepare(
        `INSERT INTO raw_archive (file_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(file_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
      ).run(id, newName, now, now);
      if (oldBase !== newBase) {
        db.prepare('INSERT INTO raw_events (file_id, kind, result, created_at) VALUES (?, ?, ?, ?)')
          .run(id, 'rename', `名称从「${oldBase}」改为「${newBase}」`, now);
      }
      if (oldDir !== newDir) {
        db.prepare('INSERT INTO raw_events (file_id, kind, result, created_at) VALUES (?, ?, ?, ?)')
          .run(id, 'move', `从「${row.path}」移动到「${target}」`, now);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  } catch (e) {
    // DB 失败：文件已在新位置，尽力移回原位保持一致
    await moved(target, row.path).catch(() => {});
    throw e;
  }
  return getRawFile(id);
}

// ---------------------------------------------------------------------------
// 移动/改名自动判定（配对合并）—— 仅在扫描正常收尾、四条件满足时由扫描器调用
// ---------------------------------------------------------------------------

/** 本次扫过作用域内的消失行（last_seen < token 且未挂 pending——排除历史待决策，不做跨会话追认）。 */
export function listScopeDisappeared(scopes: { volume: string; type: RawType }[], token: number): RawFileRow[] {
  if (!scopes.length) return [];
  const conds = scopes.map(() => '(volume = ? AND type = ?)').join(' OR ');
  return (db.prepare(
    `SELECT id, path, hash, name, ext, type, size, mtime, volume, missing, pending_missing, archived, first_seen, last_seen
     FROM raw_files WHERE (${conds}) AND last_seen < ? AND missing = 0 AND pending_missing = 0`,
  ).all(...scopes.flatMap((s) => [s.volume, s.type]), token) as SqlRow[]).map(toRow);
}

/** 全库还有几条 missing=0 的同 hash 行（排除配对双方；>0 即有副本、配对不成立）。 */
export function countOtherLiveByHash(hash: string, excludeIds: number[]): number {
  const ph = excludeIds.length ? `AND id NOT IN (${excludeIds.map(() => '?').join(',')})` : '';
  return numOf((db.prepare(
    `SELECT COUNT(*) AS n FROM raw_files WHERE hash = ? AND missing = 0 ${ph}`,
  ).get(hash, ...excludeIds) as SqlRow).n);
}

/** 'd:/rawfiles/a/b.mp4' → 'd:/rawfiles/a'。 */
function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '';
}

/** 'd:/rawfiles/a/b.mp4' → 'b'（去扩展名）。 */
function baseOf(p: string): string {
  const seg = p.slice(p.lastIndexOf('/') + 1);
  return seg.replace(/\.[a-z0-9]+$/i, '') || seg;
}

/**
 * 配对合并：旧行保留 id/name(最初名)/first_seen，UPDATE 为新位置并置 archived=1；
 * 删除本次误建的新行；raw_archive upsert（改名更新最新名）；按路径差异记 rename/move 事件（可两条）。
 * 事务保证「合并 + 归档 + 事件」原子生效。返回产生的事件种类。
 */
export function mergeMove(oldRow: RawFileRow, newRow: RawFileRow, token: number): ('rename' | 'move')[] {
  const kinds: ('rename' | 'move')[] = [];
  const oldDir = dirOf(oldRow.path);
  const newDir = dirOf(newRow.path);
  const oldBase = baseOf(oldRow.path);
  const newBase = baseOf(newRow.path);
  if (oldDir !== newDir) kinds.push('move');
  if (oldBase !== newBase) kinds.push('rename');
  if (!kinds.length) return []; // 同路径同内容（理论不可达）：无事可记

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM raw_files WHERE id = ?').run(newRow.id);
    db.prepare(
      `UPDATE raw_files SET path = ?, volume = ?, size = ?, mtime = ?, hash = ?, last_seen = ?,
       missing = 0, pending_missing = 0, archived = 1 WHERE id = ?`,
    ).run(newRow.path, newRow.volume, newRow.size, newRow.mtime, newRow.hash, token, oldRow.id);
    db.prepare(
      `INSERT INTO raw_archive (file_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(file_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    ).run(oldRow.id, newBase, token, token);
    for (const k of kinds) {
      const result = k === 'move'
        ? `从「${oldRow.path}」移动到「${newRow.path}」`
        : `名称从「${oldBase}」改为「${newBase}」`;
      db.prepare('INSERT INTO raw_events (file_id, kind, result, created_at) VALUES (?, ?, ?, ?)').run(oldRow.id, k, result, token);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return kinds;
}

/**
 * 变更日志查询：通用列表分页（kind 筛选，倒序）；file_id 时返回该文件全部事件（时间正序，弹窗用）。
 * 条目关联 raw_files 带出当前信息，行已删则 file=null。
 */
export function listRawEvents(opt: { page?: number; size?: number; kind?: string; fileId?: number }): {
  total: number;
  items: RawEventItem[];
} {
  const conds: string[] = [];
  const params: SQLInputValue[] = [];
  if (opt.kind === 'rename' || opt.kind === 'move') {
    conds.push('e.kind = ?');
    params.push(opt.kind);
  }
  if (Number.isInteger(opt.fileId) && (opt.fileId as number) > 0) {
    conds.push('e.file_id = ?');
    params.push(opt.fileId as number);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const perFile = Number.isInteger(opt.fileId) && (opt.fileId as number) > 0;
  const total = numOf((db.prepare(`SELECT COUNT(*) AS n FROM raw_events e ${where}`).get(...params) as SqlRow).n);
  if (perFile) {
    // 单文件：全量正序（时间线展示）
    const items = (db.prepare(
      `SELECT e.id, e.kind, e.result, e.created_at, f.id AS f_id, f.path AS f_path, f.hash AS f_hash,
              f.name AS f_name, f.volume AS f_volume, f.size AS f_size
       FROM raw_events e LEFT JOIN raw_files f ON f.id = e.file_id ${where} ORDER BY e.id ASC`,
    ).all(...params) as SqlRow[]).map(toEvent);
    return { total, items };
  }
  const page = Math.max(1, Number(opt.page) || 1);
  const size = Math.min(200, Math.max(1, Number(opt.size) || 50));
  const items = (db.prepare(
    `SELECT e.id, e.kind, e.result, e.created_at, f.id AS f_id, f.path AS f_path, f.hash AS f_hash,
            f.name AS f_name, f.volume AS f_volume, f.size AS f_size
     FROM raw_events e LEFT JOIN raw_files f ON f.id = e.file_id ${where}
     ORDER BY e.id DESC LIMIT ? OFFSET ?`,
  ).all(...params, size, (page - 1) * size) as SqlRow[]).map(toEvent);
  return { total, items };
}

function toEvent(r: SqlRow): RawEventItem {
  return {
    id: numOf(r.id),
    kind: r.kind === 'move' ? 'move' : 'rename',
    result: strOf(r.result),
    created_at: numOf(r.created_at),
    file: r.f_id == null
      ? null
      : {
          id: numOf(r.f_id),
          path: strOf(r.f_path),
          hash: strOf(r.f_hash),
          name: strOf(r.f_name),
          volume: strOf(r.f_volume),
          size: numOf(r.f_size),
        },
  };
}

export interface ListArchivedOpt {
  page?: number;
  size?: number;
  q?: string;
  type?: string;
  volume?: string;
}

/** 归档文件分页：archived=1 且 missing=0 的逻辑文件，附最新名（raw_archive）与变更计数。 */
export function listArchivedFiles(opt: ListArchivedOpt): { total: number; items: ArchivedItem[] } {
  const page = Math.max(1, Number(opt.page) || 1);
  const size = Math.min(200, Math.max(1, Number(opt.size) || 50));
  const where: string[] = ['f.archived = 1', 'f.missing = 0'];
  const params: SQLInputValue[] = [];
  if (opt.type === 'video' || opt.type === 'image') {
    where.push('f.type = ?');
    params.push(opt.type);
  }
  if (opt.volume) {
    where.push('f.volume = ?');
    params.push(String(opt.volume).toLowerCase());
  }
  if (opt.q) {
    where.push("(f.name LIKE ? ESCAPE '\\' OR f.path LIKE ? ESCAPE '\\')");
    const like = `%${String(opt.q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like);
  }
  const wsql = `WHERE ${where.join(' AND ')}`;
  const total = numOf((db.prepare(`SELECT COUNT(*) AS n FROM raw_files f ${wsql}`).get(...params) as SqlRow).n);
  const items = (db.prepare(
    `SELECT f.id, f.path, f.hash, f.name, f.ext, f.type, f.size, f.mtime, f.volume, f.missing,
            f.pending_missing, f.archived, f.first_seen, f.last_seen,
            COALESCE(a.name, f.name) AS latest_name,
            (SELECT COUNT(*) FROM raw_events e WHERE e.file_id = f.id) AS event_count
     FROM raw_files f LEFT JOIN raw_archive a ON a.file_id = f.id
     ${wsql} ORDER BY f.last_seen DESC, f.id DESC LIMIT ? OFFSET ?`,
  ).all(...params, size, (page - 1) * size) as SqlRow[]).map((r) => ({ ...toRow(r), latest_name: strOf(r.latest_name), event_count: numOf(r.event_count) }));
  return { total, items: items as ArchivedItem[] };
}
