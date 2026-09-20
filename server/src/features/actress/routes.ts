// 女优 API 路由：/api/actresses CRUD + disks 探测 + avatar（原始资料页设为头像）。
import { promises as fs } from 'node:fs';
import { asRecord, HttpError, json, readJson, type Route } from '../../lib/http.ts';
import { dirName } from '../../lib/paths.ts';
import { getCountryById } from '../country/countries.ts';
import { archiveRawFileTo, getRawFile } from '../raw/files.ts';
import {
  actressNameExists,
  deleteActress,
  getActress,
  insertActress,
  listActresses,
  setActressAvatar,
  updateActress,
} from './actresses.ts';

const NAME_MAX = 60;

/** 请求体通用校验载荷。 */
interface ParsedBody {
  name: string;
  countryId: number;
  rating: number | null;
  tagIds: number[];
  aliases: string[];
  disk?: string;
}

function parseBody(body: Record<string, unknown> | null, withDisk: boolean): ParsedBody {
  const name = String(body?.name ?? '').trim();
  if (!name) throw new HttpError(400, '女优名不能为空');
  if (name.length > NAME_MAX) throw new HttpError(400, `女优名过长（≤${NAME_MAX} 字符）`);
  const countryId = Number(body?.countryId);
  if (!Number.isInteger(countryId) || countryId <= 0) throw new HttpError(400, '缺少国家或国家 id 非法');
  if (!getCountryById(countryId)) throw new HttpError(400, '国家不存在，请先到国家页添加');
  let rating: number | null = null;
  if (body?.rating != null) {
    rating = Number(body.rating);
    if (!Number.isInteger(rating) || rating < 0 || rating > 100) throw new HttpError(400, '评分须为 0-100 整数');
  }
  const rawTags = Array.isArray(body?.tagIds) ? body.tagIds : [];
  const tagIds = rawTags.map((v) => Number(v));
  if (!tagIds.every((n) => Number.isInteger(n) && n > 0)) throw new HttpError(400, 'tagIds 含非法值');
  const rawAliases = Array.isArray(body?.aliases) ? body.aliases : [];
  const aliases = [...new Set(rawAliases.map((v) => String(v ?? '').trim()))].filter(Boolean);
  if (aliases.some((a) => a.length > NAME_MAX)) throw new HttpError(400, `别名过长（≤${NAME_MAX} 字符）`);
  const out: ParsedBody = { name, countryId, rating, tagIds, aliases };
  if (withDisk) {
    const disk = String(body?.disk ?? '').toLowerCase();
    if (!/^[a-z]:$/.test(disk)) throw new HttpError(400, '盘符非法（形如 d:）');
    out.disk = disk;
  }
  return out;
}

function ensureNameUnique(name: string, excludeId = 0): void {
  if (actressNameExists(name, excludeId)) throw new HttpError(409, '女优已存在');
}

function parseId(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'id 非法');
  return id;
}

/** 女优图集目录（头像落点）：{disk}/Archives/{国家}/{女优}/图集。 */
function galleryDir(actress: { name: string; country_id: number; disk: string }): string {
  const country = getCountryById(actress.country_id);
  const countrySeg = country ? dirName(country.name) : 'unnamed';
  return `${actress.disk}/Archives/${countrySeg}/${dirName(actress.name)}/图集`;
}

const listRoute: Route['handler'] = ({ res, url }) => {
  json(res, 200, { ok: true, items: listActresses(url.searchParams.get('q') ?? '') });
};

// 可用盘符：A:–Z: 根目录存在者（创建表单磁盘单选；不复用 RawFiles 限定探测）
const disksRoute: Route['handler'] = async ({ res }) => {
  const disks: string[] = [];
  for (let c = 97; c <= 122; c++) {
    const vol = `${String.fromCharCode(c)}:`;
    try {
      const st = await fs.stat(`${vol}/`);
      if (st.isDirectory()) disks.push(vol);
    } catch { /* 盘不存在 */ }
  }
  json(res, 200, { ok: true, disks });
};

const createRoute: Route['handler'] = async ({ req, res }) => {
  const p = parseBody(asRecord(await readJson(req)), true);
  ensureNameUnique(p.name);
  // 创建即建目录树（幂等；失败报因——盘不存在等）
  const dir = `${p.disk}/Archives/${dirName(getCountryById(p.countryId)!.name)}/${dirName(p.name)}/图集`;
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    throw new HttpError(400, `目录创建失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const item = insertActress({ name: p.name, countryId: p.countryId, rating: p.rating, disk: p.disk!, tagIds: p.tagIds, aliases: p.aliases });
  json(res, 200, { ok: true, item });
};

const updateRoute: Route['handler'] = async ({ req, res, params }) => {
  const id = parseId(params.id);
  const p = parseBody(asRecord(await readJson(req)), false);
  ensureNameUnique(p.name, id);
  const item = updateActress(id, { name: p.name, countryId: p.countryId, rating: p.rating, tagIds: p.tagIds, aliases: p.aliases });
  if (!item) throw new HttpError(404, '女优不存在');
  json(res, 200, { ok: true, item });
};

const deleteRoute: Route['handler'] = ({ res, params }) => {
  const id = parseId(params.id);
  if (!deleteActress(id)) throw new HttpError(404, '女优不存在');
  json(res, 200, { ok: true });
};

// 原始资料页设为头像：raw 行须为图片 → 物理移动+改名 head.{ext} 至图集目录（真·归档）→ 更新引用
const avatarRoute: Route['handler'] = async ({ req, res, params }) => {
  const id = parseId(params.id);
  const actress = getActress(id);
  if (!actress) throw new HttpError(404, '女优不存在');
  const body = asRecord(await readJson(req));
  const fileId = Number(body?.fileId);
  if (!Number.isInteger(fileId) || fileId <= 0) throw new HttpError(400, '缺少 fileId');
  const row = getRawFile(fileId);
  if (!row) throw new HttpError(404, '文件不存在');
  if (row.type !== 'image') throw new HttpError(400, '仅图片可设为头像');
  const newPath = `${galleryDir(actress)}/head.${row.ext}`;
  await archiveRawFileTo(fileId, newPath); // 行跟随 + archived=1 + 归档登记 + 事件；已在原位时幂等
  setActressAvatar(id, fileId);
  json(res, 200, { ok: true, item: getActress(id) });
};

export const actressRoutes: Route[] = [
  { method: 'GET', path: '/api/actresses', handler: listRoute },
  { method: 'GET', path: '/api/actresses/disks', handler: disksRoute },
  { method: 'POST', path: '/api/actresses', handler: createRoute },
  { method: 'PUT', path: '/api/actresses/:id', handler: updateRoute },
  { method: 'POST', path: '/api/actresses/:id/delete', handler: deleteRoute },
  { method: 'POST', path: '/api/actresses/:id/avatar', handler: avatarRoute },
];
