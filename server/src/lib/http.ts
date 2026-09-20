// HTTP 基础设施：JSON 响应 / 请求体读取 / 行为化错误 / 路由类型 / 安全文件流。
import { createReadStream, type ReadStream } from 'node:fs';
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

/**
 * 安全文件流：createReadStream + pipe 的统一封装。
 * 必须挂 error 处理——ReadStream 的读错误（文件被中途移走、坏道、拔盘）若无监听器，
 * 会被 Node 当作 uncaughtException 直接杀死进程（实测：G 盘坏道文件一点播放全服崩溃）。
 * 客户端中断（seek/关弹窗断开连接）时同步销毁流，避免后台读完整文件的句柄泄漏。
 */
export function streamFile(
  res: ServerResponse,
  file: string,
  opts?: { start?: number; end?: number },
): void {
  const stream = createReadStream(file, opts);
  stream.on('error', (e: unknown) => {
    if (!res.headersSent) {
      json(res, 500, { ok: false, error: `读取文件失败（可能已被移动、删除或磁盘故障）：${e instanceof Error ? e.message : String(e)}` });
    } else {
      res.destroy(); // 头已发出（部分传输中）——只能断开连接
    }
    stream.destroy();
  });
  res.on('close', () => stream.destroy()); // 客户端中断 → 释放句柄
  stream.pipe(res);
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
