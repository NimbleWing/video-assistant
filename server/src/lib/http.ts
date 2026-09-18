// HTTP 基础设施：JSON 响应 / 请求体读取 / 行为化错误 / 路由类型。
import type { IncomingMessage, ServerResponse } from 'node:http';

/** handler 内抛出 → 统一转 JSON 错误响应（code 即 HTTP 状态码）。 */
export class HttpError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export function json(res: ServerResponse, code: number, data: unknown): void {
  const buf = Buffer.from(JSON.stringify(data));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

/** 读取 JSON 请求体（上限 1MB；空体返回 null；非法 JSON / 过大抛 HttpError）。 */
export function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let len = 0;
    req.on('data', (c: Buffer) => {
      len += c.length;
      if (len > 1024 * 1024) {
        reject(new HttpError(413, '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** unknown 收窄为普通对象（请求体入口校验）。 */
export function asRecord(v: unknown): Record<string, unknown> | null {
  return v != null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** 路由请求上下文：params 为路径占位符（如 /stream/:id 的 id）。 */
export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
}

export type RouteHandler = (ctx: RequestContext) => Promise<void> | void;

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'HEAD';
  path: string;
  handler: RouteHandler;
}
