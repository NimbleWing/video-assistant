// 应用组装：极简路由表（method+pattern+handler，零框架）注册各 feature、
// 静态服务兜底、写操作 Origin 守卫、异常统一转 JSON。listen 由 server.ts 负责。
import http from 'node:http';
import { HttpError, json, type Route } from './lib/http.ts';
import { serveStatic } from './lib/static.ts';
import { mediaRoutes } from './features/media/index.ts';
import { rawRoutes } from './features/raw/index.ts';
import { ledgerRoutes } from './features/ledger/index.ts';
import { countryRoutes } from './features/country/index.ts';
import { tagRoutes } from './features/tag/index.ts';
import { studioRoutes } from './features/studio/index.ts';
import { actressRoutes } from './features/actress/index.ts';
import { systemRoutes } from './features/system/index.ts';

export const HOST = '127.0.0.1';
export const PORT = 17321;

/** 允许发起写操作的来源：扩展 + 管理页自身 + server-web 开发服（vite）；无 Origin（curl 等）放行 */
const ALLOWED_ORIGINS = [
  'chrome-extension://fieogbjpjaiokpmfkokckebfaojncomm',
  `http://${HOST}:${PORT}`,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

const ROUTES: Route[] = [...systemRoutes, ...mediaRoutes, ...rawRoutes, ...ledgerRoutes, ...countryRoutes, ...tagRoutes, ...studioRoutes, ...actressRoutes];

/** 路径匹配：段精确相等；':x' 段为参数占位（如 /stream/:id）。未匹配返回 null。 */
function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const ps = pattern.split('/');
  const xs = pathname.split('/');
  if (ps.length !== xs.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i] as string;
    const x = xs[i] as string;
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(x);
    else if (p !== x) return null;
  }
  return params;
}

export function createApp(): http.Server {
  return http.createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) {
        json(res, e.code, { ok: false, error: e.message });
        return;
      }
      json(res, 500, { ok: false, error: String(e instanceof Error ? e.message : e) });
    });
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const u = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const pathname = u.pathname;

  // 写操作校验来源；GET/HEAD（只读 + 流播放）放行
  if (req.method === 'POST' || req.method === 'PUT') {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(String(origin))) {
      json(res, 403, { ok: false, error: '来源不被允许' });
      return;
    }
  }

  // 静态资源（public/，管理页构建产物）；未命中则继续走 API 路由
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (await serveStatic(req, res, pathname)) return;
  }

  for (const r of ROUTES) {
    if (r.method !== req.method) continue;
    const params = matchPath(r.path, pathname);
    if (!params) continue;
    await r.handler({ req, res, url: u, params });
    return;
  }

  json(res, 404, { ok: false, error: 'not found' });
}
