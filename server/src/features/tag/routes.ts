// 标签字典 API 路由：/api/tags GET（全量）/ POST（新增）、/api/tags/:id PUT（改名）、
// POST /delete（删除——路由器不支持 DELETE 方法，沿用 raw 惯例）、POST /reorder（拖拽排序）。
import { asRecord, HttpError, json, readJson, type Route } from '../../lib/http.ts';
import { deleteTag, insertTag, listTags, renameTag, reorderTags, tagNameExists } from './tags.ts';

const NAME_MAX = 60;

/** 请求体 name 校验：trim 非空、≤60。返回归一化后的值。 */
function validName(body: Record<string, unknown> | null): string {
  const name = String(body?.name ?? '').trim();
  if (!name) throw new HttpError(400, '标签名不能为空');
  if (name.length > NAME_MAX) throw new HttpError(400, `标签名过长（≤${NAME_MAX} 字符）`);
  return name;
}

/** 重名检查：409。excludeId 供改名排除自身。 */
function ensureUnique(name: string, excludeId = 0): void {
  if (tagNameExists(name, excludeId)) throw new HttpError(409, '标签已存在');
}

function parseId(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'id 非法');
  return id;
}

const listRoute: Route['handler'] = ({ res }) => {
  json(res, 200, { ok: true, items: listTags() });
};

const createRoute: Route['handler'] = async ({ req, res }) => {
  const name = validName(asRecord(await readJson(req)));
  ensureUnique(name);
  json(res, 200, { ok: true, item: insertTag(name) });
};

const renameRoute: Route['handler'] = async ({ req, res, params }) => {
  const id = parseId(params.id);
  const name = validName(asRecord(await readJson(req)));
  ensureUnique(name, id);
  const item = renameTag(id, name);
  if (!item) throw new HttpError(404, '标签不存在');
  json(res, 200, { ok: true, item });
};

const deleteRoute: Route['handler'] = ({ res, params }) => {
  const id = parseId(params.id);
  if (!deleteTag(id)) throw new HttpError(404, '标签不存在');
  json(res, 200, { ok: true });
};

// 拖拽排序：{ids:[...]} 按新顺序全量重编号；响应直接返回新列表（前端乐观更新后对齐权威顺序）
const reorderRoute: Route['handler'] = async ({ req, res }) => {
  const body = asRecord(await readJson(req));
  const raw = body?.ids;
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, '缺少 ids 数组');
  const ids = raw.map((v) => Number(v));
  if (!ids.every((n) => Number.isInteger(n) && n > 0)) throw new HttpError(400, 'ids 含非法值');
  reorderTags(ids);
  json(res, 200, { ok: true, items: listTags() });
};

export const tagRoutes: Route[] = [
  { method: 'GET', path: '/api/tags', handler: listRoute },
  { method: 'POST', path: '/api/tags', handler: createRoute },
  { method: 'PUT', path: '/api/tags/:id', handler: renameRoute },
  { method: 'POST', path: '/api/tags/:id/delete', handler: deleteRoute },
  { method: 'POST', path: '/api/tags/reorder', handler: reorderRoute },
];
