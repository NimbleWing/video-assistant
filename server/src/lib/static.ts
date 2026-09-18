// 静态资源服务：public/（管理页构建产物，源码见 ../server-web）。
// 归一化后限制在 public 目录内，防路径穿越；未命中返回 false 交回 API 路由。
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SERVER_ROOT } from './db.ts';

const PUBLIC_DIR = path.join(SERVER_ROOT, 'public');

/** 静态资源 MIME @type {Record<string, string>} */
const STATIC_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

export async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  let decoded: string;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return false;
  }
  const file = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
  let st;
  try {
    st = await fs.stat(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const mime = STATIC_MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime, 'Content-Length': st.size, 'Cache-Control': 'no-store' });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(file).pipe(res);
  return true;
}
