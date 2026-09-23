// videos + 四张多对多关系表：作品（原始资料页归档流落库）。
// DDL + 全部数据操作，仅此文件触碰本五表。计数导出供 actress/tag/studio feature 真实化（放宽规则先例）。
// video_file 缝合经 raw feature 导出纯查询（getRawFilesByIds）协作，同为先例范畴。
import { db, numOf, strOf, type SqlRow } from '../../lib/db.ts';
import { getRawFilesByIds } from '../raw/files.ts';
import type { RawFileRow } from '../raw/types.ts';
import type { VideoRow } from './types.ts';

db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    kind           TEXT NOT NULL CHECK (kind IN ('single','series')),
    title          TEXT NOT NULL,
    subtitle       TEXT,
    code           TEXT,
    rating         INTEGER,
    video_file_id  INTEGER NOT NULL,
    cover_file_id  INTEGER,
    created_at     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS actress_videos (video_id INTEGER NOT NULL, actress_id INTEGER NOT NULL, PRIMARY KEY (video_id, actress_id));
  CREATE TABLE IF NOT EXISTS tag_videos     (video_id INTEGER NOT NULL, tag_id     INTEGER NOT NULL, PRIMARY KEY (video_id, tag_id));
  CREATE TABLE IF NOT EXISTS studio_videos  (video_id INTEGER NOT NULL, studio_id  INTEGER NOT NULL, PRIMARY KEY (video_id, studio_id));
  CREATE TABLE IF NOT EXISTS country_videos (video_id INTEGER NOT NULL, country_id INTEGER NOT NULL, PRIMARY KEY (video_id, country_id));
`);
// rating 列（2026-09-23 视频卡片复刻：作品评分；2026-09-24 语义改为加分制——
// rating = 加分配额（0 至 100−基础分），基础分 = 关联演员最高评分，展示分 = min(100, 基础分 + 加分)）
try {
  db.exec('ALTER TABLE videos ADD rating INTEGER');
} catch {
  /* 列已存在 */
}
// 加分制迁移：旧绝对分无法换算，一次性清零重评（PRAGMA user_version 幂等栅栏）
if (numOf((db.prepare('PRAGMA user_version').get() as SqlRow).user_version) < 1) {
  db.exec('UPDATE videos SET rating = NULL');
  db.exec('PRAGMA user_version = 1');
}

/** 作品归档写入（文件移动已由路由层完成）：videos + 四张关系表，单事务。 */
export function insertVideo(v: {
  kind: 'single' | 'series';
  title: string;
  subtitle: string | null;
  code: string | null;
  rating: number | null;
  videoFileId: number;
  coverFileId: number | null;
  actressIds: number[];
  tagIds: number[];
  studioId: number | null;
  countryId: number;
}): VideoRow {
  const now = Date.now();
  db.exec('BEGIN');
  let id = 0;
  try {
    const r = db.prepare(
      'INSERT INTO videos (kind, title, subtitle, code, rating, video_file_id, cover_file_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(v.kind, v.title, v.subtitle, v.code, v.rating, v.videoFileId, v.coverFileId, now);
    id = numOf(r.lastInsertRowid);
    for (const a of v.actressIds) db.prepare('INSERT OR IGNORE INTO actress_videos (video_id, actress_id) VALUES (?, ?)').run(id, a);
    for (const t of v.tagIds) db.prepare('INSERT OR IGNORE INTO tag_videos (video_id, tag_id) VALUES (?, ?)').run(id, t);
    if (v.studioId) db.prepare('INSERT OR IGNORE INTO studio_videos (video_id, studio_id) VALUES (?, ?)').run(id, v.studioId);
    db.prepare('INSERT OR IGNORE INTO country_videos (video_id, country_id) VALUES (?, ?)').run(id, v.countryId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getVideo(id)!;
}

interface VideoExtras {
  actresses: Map<number, { id: number; name: string }[]>;
  /** 各作品基础分（关联演员最高评分，未评分按 0）。 */
  base: Map<number, number>;
  tags: Map<number, { id: number; name: string; sort: number }[]>;
  studios: Map<number, { id: number; name: string }[]>;
  countries: Map<number, { id: number; name: string }[]>;
}

function toVideoFile(f: RawFileRow | undefined): VideoRow['video_file'] {
  return f ? { id: f.id, path: f.path, ext: f.ext, size: f.size, duration: f.duration, width: f.width, height: f.height } : null;
}

function toRow(r: SqlRow, x: VideoExtras, files: Map<number, RawFileRow>): VideoRow {
  const id = numOf(r.id);
  return {
    id,
    kind: strOf(r.kind) as VideoRow['kind'],
    title: strOf(r.title),
    subtitle: r.subtitle == null ? null : strOf(r.subtitle),
    code: r.code == null ? null : strOf(r.code),
    rating: r.rating == null ? null : numOf(r.rating),
    base_rating: x.base.get(id) ?? 0,
    video_file_id: numOf(r.video_file_id),
    cover_file_id: r.cover_file_id == null ? null : numOf(r.cover_file_id),
    created_at: numOf(r.created_at),
    video_file: toVideoFile(files.get(numOf(r.video_file_id))),
    actresses: x.actresses.get(id) ?? [],
    tags: x.tags.get(id) ?? [],
    studios: x.studios.get(id) ?? [],
    countries: x.countries.get(id) ?? [],
  };
}

/** 按 id 集取完整作品（含四维 join 缝合），列表与单取共用。 */
function listVideosByIds(ids: number[]): Map<number, VideoRow> {
  const ph = ids.length ? ids.join(',') : '0';
  const base = new Map<number, SqlRow>();
  for (const r of db.prepare(`SELECT * FROM videos WHERE id IN (${ph})`).all() as SqlRow[]) base.set(numOf(r.id), r);
  const x: VideoExtras = { actresses: new Map(), base: new Map(), tags: new Map(), studios: new Map(), countries: new Map() };
  for (const r of db.prepare(
    `SELECT av.video_id AS vid, a.id AS aid, a.name AS aname, a.rating AS arating FROM actress_videos av
     JOIN actresses a ON a.id = av.actress_id WHERE av.video_id IN (${ph}) ORDER BY av.actress_id ASC`,
  ).all() as SqlRow[]) {
    const vid = numOf(r.vid);
    const arr = x.actresses.get(vid) ?? [];
    arr.push({ id: numOf(r.aid), name: strOf(r.aname) });
    x.actresses.set(vid, arr);
    x.base.set(vid, Math.max(x.base.get(vid) ?? 0, r.arating == null ? 0 : numOf(r.arating)));
  }
  for (const r of db.prepare(
    `SELECT tv.video_id AS vid, t.id AS tid, t.name AS tname, t.sort AS tsort FROM tag_videos tv
     JOIN tags t ON t.id = tv.tag_id WHERE tv.video_id IN (${ph}) ORDER BY t.sort ASC, t.id ASC`,
  ).all() as SqlRow[]) {
    const vid = numOf(r.vid);
    const arr = x.tags.get(vid) ?? [];
    arr.push({ id: numOf(r.tid), name: strOf(r.tname), sort: numOf(r.tsort) });
    x.tags.set(vid, arr);
  }
  for (const r of db.prepare(
    `SELECT sv.video_id AS vid, s.id AS sid, s.name AS sname FROM studio_videos sv
     JOIN studios s ON s.id = sv.studio_id WHERE sv.video_id IN (${ph})`,
  ).all() as SqlRow[]) {
    const vid = numOf(r.vid);
    const arr = x.studios.get(vid) ?? [];
    arr.push({ id: numOf(r.sid), name: strOf(r.sname) });
    x.studios.set(vid, arr);
  }
  for (const r of db.prepare(
    `SELECT cv.video_id AS vid, c.id AS cid, c.name AS cname FROM country_videos cv
     JOIN countries c ON c.id = cv.country_id WHERE cv.video_id IN (${ph})`,
  ).all() as SqlRow[]) {
    const vid = numOf(r.vid);
    const arr = x.countries.get(vid) ?? [];
    arr.push({ id: numOf(r.cid), name: strOf(r.cname) });
    x.countries.set(vid, arr);
  }
  const out = new Map<number, VideoRow>();
  const files = getRawFilesByIds([...base.values()].map((r) => numOf(r.video_file_id)));
  for (const r of base.values()) out.set(numOf(r.id), toRow(r, x, files));
  return out;
}

export interface ListVideosOpt {
  page?: number;
  size?: number;
  q?: string;
  /** kind 区分单片/剧集（视频库页传 single，将来剧集库页传 series）。 */
  kind?: 'single' | 'series';
  actressId?: number;
  tagId?: number;
  studioId?: number;
}

/** 作品分页列表（title/subtitle/code LIKE；kind/演员/标签/片商筛选；created_at 倒序）。 */
export function listVideos(opt: ListVideosOpt): { total: number; items: VideoRow[] } {
  const page = Math.max(1, Number(opt.page) || 1);
  const size = Math.min(200, Math.max(1, Number(opt.size) || 50));
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opt.kind === 'single' || opt.kind === 'series') {
    where.push('kind = ?');
    params.push(opt.kind);
  }
  if (opt.actressId) {
    where.push('id IN (SELECT video_id FROM actress_videos WHERE actress_id = ?)');
    params.push(opt.actressId);
  }
  if (opt.tagId) {
    where.push('id IN (SELECT video_id FROM tag_videos WHERE tag_id = ?)');
    params.push(opt.tagId);
  }
  if (opt.studioId) {
    where.push('id IN (SELECT video_id FROM studio_videos WHERE studio_id = ?)');
    params.push(opt.studioId);
  }
  if (opt.q) {
    where.push("(title LIKE ? ESCAPE '\\' OR subtitle LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\')");
    const like = `%${String(opt.q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like, like);
  }
  const wsql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = numOf((db.prepare(`SELECT COUNT(*) AS n FROM videos ${wsql}`).get(...params) as SqlRow).n);
  const ids = (db.prepare(`SELECT id FROM videos ${wsql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, size, (page - 1) * size) as SqlRow[]).map((r) => numOf(r.id));
  const map = listVideosByIds(ids);
  return { total, items: ids.map((id) => map.get(id)).filter((v): v is VideoRow => v != null) };
}

/** 按 id 取作品。 */
export function getVideo(id: number): VideoRow | null {
  return listVideosByIds([id]).get(id) ?? null;
}

/** 更新加分配额（0 至 100−基础分 或 null 清除；取值域由路由层按 base_rating 校验）。目标不存在返回 null。 */
export function setVideoRating(id: number, rating: number | null): VideoRow | null {
  const r = db.prepare('UPDATE videos SET rating = ? WHERE id = ?').run(rating, id);
  return Number(r.changes) > 0 ? getVideo(id) : null;
}

// ---------------- 计数导出（actress/tag/studio 列表真实化用） ----------------

/** 各演员作品数（actresses.video_count）。 */
export function actressVideoCounts(): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of db.prepare('SELECT actress_id, COUNT(*) AS n FROM actress_videos GROUP BY actress_id').all() as SqlRow[]) {
    m.set(numOf(r.actress_id), numOf(r.n));
  }
  return m;
}

/** 各标签作品数（tags.video_count）。 */
export function tagVideoCounts(): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of db.prepare('SELECT tag_id, COUNT(*) AS n FROM tag_videos GROUP BY tag_id').all() as SqlRow[]) {
    m.set(numOf(r.tag_id), numOf(r.n));
  }
  return m;
}

/** 各片商作品数（studios.video_count）。 */
export function studioVideoCounts(): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of db.prepare('SELECT studio_id, COUNT(*) AS n FROM studio_videos GROUP BY studio_id').all() as SqlRow[]) {
    m.set(numOf(r.studio_id), numOf(r.n));
  }
  return m;
}

/** 各片商作品关联演员的去重数（studios.actor_count）。 */
export function studioActorCounts(): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of db.prepare(
    `SELECT sv.studio_id AS sid, COUNT(DISTINCT av.actress_id) AS n
     FROM studio_videos sv JOIN actress_videos av ON av.video_id = sv.video_id
     GROUP BY sv.studio_id`,
  ).all() as SqlRow[]) {
    m.set(numOf(r.sid), numOf(r.n));
  }
  return m;
}
