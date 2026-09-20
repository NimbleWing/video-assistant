// 片商字典 API 路由：/api/studios CRUD + logo 三端点（设置/替换、字节直出、清除）。
// logo 载荷统一 JSON：{b64}（前端文件转 base64）或 {url}（服务端抓取，仅 http/https）；
// 解码/抓取后一律魔数白名单 jpg/png/webp + ≤512KB（零依赖无图像处理，存原始字节）。
import { HttpError, asRecord, json, readJson, type Route } from '../../lib/http.ts';
import {
  clearStudioLogo,
  deleteStudio,
  getStudioLogo,
  insertStudio,
  listStudios,
  renameStudio,
  setStudioLogo,
  studioExists,
  studioNameExists,
} from './studios.ts';

const NAME_MAX = 60;
const LOGO_MAX = 512 * 1024;

/** 请求体 name 校验：trim 非空、≤60。返回归一化后的值。 */
function validName(body: Record<string, unknown> | null): string {
  const name = String(body?.name ?? '').trim();
  if (!name) throw new HttpError(400, '片商名不能为空');
  if (name.length > NAME_MAX) throw new HttpError(400, `片商名过长（≤${NAME_MAX} 字符）`);
  return name;
}

/** 重名检查：409。excludeId 供改名排除自身。 */
function ensureUnique(name: string, excludeId = 0): void {
  if (studioNameExists(name, excludeId)) throw new HttpError(409, '片商已存在');
}

function parseId(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'id 非法');
  return id;
}

/** 魔数嗅探：jpg / png / webp → MIME；其他返回 null（零依赖无图像处理，只认白名单）。 */
function sniffImageType(b: Uint8Array): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 12) {
    const riff = String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!);
    const webp = String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!);
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  }
  return null;
}

/** 字节校验（大小 + 魔数），返回 MIME；违规抛 400 报因。 */
function validateLogoBytes(bytes: Uint8Array): string {
  if (bytes.length === 0) throw new HttpError(400, 'logo 内容为空');
  if (bytes.length > LOGO_MAX) throw new HttpError(400, 'logo 超过 512KB 上限');
  const type = sniffImageType(bytes);
  if (!type) throw new HttpError(400, '仅支持 jpg / png / webp 图片');
  return type;
}

/** URL 抓取：仅 http/https，5s 超时；Content-Length 预检 + 实际大小复核。 */
async function fetchLogoBytes(url: string): Promise<Uint8Array> {
  if (!/^https?:\/\//i.test(url)) throw new HttpError(400, '仅支持 http/https 地址');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) throw new HttpError(400, `抓取失败：HTTP ${r.status}`);
    const len = Number(r.headers.get('content-length') || 0);
    if (len > LOGO_MAX) throw new HttpError(400, 'logo 超过 512KB 上限');
    return new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, `抓取失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

const listRoute: Route['handler'] = ({ res }) => {
  json(res, 200, { ok: true, items: listStudios() });
};

const createRoute: Route['handler'] = async ({ req, res }) => {
  const name = validName(asRecord(await readJson(req)));
  ensureUnique(name);
  json(res, 200, { ok: true, item: insertStudio(name) });
};

const renameRoute: Route['handler'] = async ({ req, res, params }) => {
  const id = parseId(params.id);
  const name = validName(asRecord(await readJson(req)));
  ensureUnique(name, id);
  const item = renameStudio(id, name);
  if (!item) throw new HttpError(404, '片商不存在');
  json(res, 200, { ok: true, item });
};

const deleteRoute: Route['handler'] = ({ res, params }) => {
  const id = parseId(params.id);
  if (!deleteStudio(id)) throw new HttpError(404, '片商不存在');
  json(res, 200, { ok: true });
};

// 设置/替换 logo：{b64} 或 {url}，二选一（都给时 b64 优先）
const setLogoRoute: Route['handler'] = async ({ req, res, params }) => {
  const id = parseId(params.id);
  if (!studioExists(id)) throw new HttpError(404, '片商不存在');
  const body = asRecord(await readJson(req));
  let bytes: Uint8Array;
  const b64 = typeof body?.b64 === 'string' ? body.b64 : '';
  const url = typeof body?.url === 'string' ? body.url.trim() : '';
  if (b64) {
    try {
      bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    } catch {
      throw new HttpError(400, 'b64 解码失败');
    }
  } else if (url) {
    bytes = await fetchLogoBytes(url);
  } else {
    throw new HttpError(400, '缺少 b64 或 url');
  }
  const logoType = validateLogoBytes(bytes);
  json(res, 200, { ok: true, item: setStudioLogo(id, bytes, logoType) });
};

// logo 字节直出（Content-Type + 短缓存；前端替换后 ?v= 版本号 bust）
const getLogoRoute: Route['handler'] = ({ res, params }) => {
  const id = parseId(params.id);
  const r = getStudioLogo(id);
  if (!r) throw new HttpError(404, '无 logo');
  const buf = Buffer.from(r.logo);
  res.writeHead(200, {
    'Content-Type': r.logoType,
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=300',
  });
  res.end(buf);
};

const clearLogoRoute: Route['handler'] = ({ res, params }) => {
  const id = parseId(params.id);
  if (!studioExists(id)) throw new HttpError(404, '片商不存在');
  clearStudioLogo(id);
  json(res, 200, { ok: true });
};

export const studioRoutes: Route[] = [
  { method: 'GET', path: '/api/studios', handler: listRoute },
  { method: 'POST', path: '/api/studios', handler: createRoute },
  { method: 'PUT', path: '/api/studios/:id', handler: renameRoute },
  { method: 'POST', path: '/api/studios/:id/delete', handler: deleteRoute },
  { method: 'POST', path: '/api/studios/:id/logo', handler: setLogoRoute },
  { method: 'GET', path: '/api/studios/:id/logo', handler: getLogoRoute },
  { method: 'POST', path: '/api/studios/:id/logo/delete', handler: clearLogoRoute },
];
