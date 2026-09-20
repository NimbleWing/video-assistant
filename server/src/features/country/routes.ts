// 国家字典 API 路由：/api/countries GET（全量）/ POST（新增）、
// /api/countries/:id PUT（改名）/ POST /delete（删除——路由器不支持 DELETE 方法，沿用 raw 惯例）。
import { asRecord, HttpError, json, readJson, type Route } from '../../lib/http.ts';
import { countryNameExists, deleteCountry, insertCountry, listCountries, renameCountry } from './countries.ts';

const NAME_MAX = 60;

/** 请求体 name 校验：trim 非空、≤60。返回归一化后的值。 */
function validName(body: Record<string, unknown> | null): string {
  const name = String(body?.name ?? '').trim();
  if (!name) throw new HttpError(400, '国家名不能为空');
  if (name.length > NAME_MAX) throw new HttpError(400, `国家名过长（≤${NAME_MAX} 字符）`);
  return name;
}

/** 重名检查：409。excludeId 供改名排除自身。 */
function ensureUnique(name: string, excludeId = 0): void {
  if (countryNameExists(name, excludeId)) throw new HttpError(409, '国家已存在');
}

function parseId(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'id 非法');
  return id;
}

const listRoute: Route['handler'] = ({ res }) => {
  json(res, 200, { ok: true, items: listCountries() });
};

const createRoute: Route['handler'] = async ({ req, res }) => {
  const name = validName(asRecord(await readJson(req)));
  ensureUnique(name);
  json(res, 200, { ok: true, item: insertCountry(name) });
};

const renameRoute: Route['handler'] = async ({ req, res, params }) => {
  const id = parseId(params.id);
  const name = validName(asRecord(await readJson(req)));
  ensureUnique(name, id);
  const item = renameCountry(id, name);
  if (!item) throw new HttpError(404, '国家不存在');
  json(res, 200, { ok: true, item });
};

const deleteRoute: Route['handler'] = ({ res, params }) => {
  const id = parseId(params.id);
  if (!deleteCountry(id)) throw new HttpError(404, '国家不存在');
  json(res, 200, { ok: true });
};

export const countryRoutes: Route[] = [
  { method: 'GET', path: '/api/countries', handler: listRoute },
  { method: 'POST', path: '/api/countries', handler: createRoute },
  { method: 'PUT', path: '/api/countries/:id', handler: renameRoute },
  { method: 'POST', path: '/api/countries/:id/delete', handler: deleteRoute },
];
