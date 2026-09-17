// 本地媒体库服务：127.0.0.1:17321。
// 去重判定 / 下载账本 / 磁盘扫描 / 管理页与 Range 流播放。
// 设计文档见同目录 DESIGN.md。
import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  db, setMeta, queryExists, listVideos, listVolumes,
  upsertFileRecorded, upsertDownload, listDownloads,
} from './db.js';
import { scanAll, scanDirs } from './scanner.js';

const PORT = 17321;
const HOST = '127.0.0.1';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
/** 允许发起写操作的来源：扩展 + 管理页自身；无 Origin（curl 等）放行 */
const ALLOWED_ORIGINS = [
  'chrome-extension://fieogbjpjaiokpmfkokckebfaojncomm',
  `http://${HOST}:${PORT}`,
];
const DL_STATUSES = new Set(['downloading', 'complete', 'failed', 'canceled', 'skipped']);

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    json(res, 500, { ok: false, error: String(/** @type {Error} */ (e)?.message || e) });
  });
});

/**
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 */
async function handle(req, res) {
  const u = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const pathname = u.pathname;

  // 写操作校验来源；GET/HEAD（只读 + 流播放）放行
  if (req.method === 'POST' || req.method === 'PUT') {
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(String(origin))) {
      json(res, 403, { ok: false, error: '来源不被允许' });
      return;
    }
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const html = await fs.readFile(path.join(ROOT, 'public', 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/exists') {
    const rel = u.searchParams.get('rel') || u.searchParams.get('name') || '';
    json(res, 200, { ok: true, ...queryExists(rel) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/downloads') {
    const body = await readJson(req);
    if (!body?.videoId || !DL_STATUSES.has(String(body.status))) {
      json(res, 400, { ok: false, error: '缺少 videoId 或 status 非法' });
      return;
    }
    upsertDownload({
      site: body.site ? String(body.site) : undefined,
      videoId: String(body.videoId),
      pagePath: body.pagePath ? String(body.pagePath) : undefined,
      name: body.name ? String(body.name) : undefined,
      seriesName: body.seriesName != null ? String(body.seriesName) : undefined,
      quality: body.quality != null ? Number(body.quality) || undefined : undefined,
      filename: body.filename ? String(body.filename) : undefined,
      status: String(body.status),
      error: body.error != null ? String(body.error).slice(0, 300) : undefined,
      size: body.size != null ? Number(body.size) || undefined : undefined,
    });
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/files') {
    const body = await readJson(req);
    if (!body?.absPath) { json(res, 400, { ok: false, error: '缺少 absPath' }); return; }
    upsertFileRecorded({
      path: String(body.absPath),
      size: body.size != null ? Number(body.size) || 0 : 0,
      videoId: body.videoId ? String(body.videoId) : undefined,
      duration: body.duration != null ? Number(body.duration) || undefined : undefined,
    });
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/scan') {
    json(res, 200, { ok: true, result: await scanAll() });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/config') {
    json(res, 200, { ok: true, scanDirs: scanDirs() });
    return;
  }
  if (req.method === 'POST' && pathname === '/api/config') {
    const body = await readJson(req);
    const dirs = Array.isArray(body?.scanDirs) ? body.scanDirs.map((/** @type {any} */ d) => String(d).trim()).filter(Boolean) : null;
    if (!dirs) { json(res, 400, { ok: false, error: 'scanDirs 应为数组' }); return; }
    // 逐个校验目录存在性，收集警告但不阻断保存
    /** @type {string[]} */
    const warnings = [];
    for (const d of dirs) {
      try {
        const st = await fs.stat(d);
        if (!st.isDirectory()) warnings.push(`${d} 不是目录`);
      } catch {
        warnings.push(`${d} 不存在或不可访问`);
      }
    }
    setMeta('scan_dirs', JSON.stringify(dirs));
    json(res, 200, { ok: true, warnings });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/videos') {
    json(res, 200, {
      ok: true,
      ...listVideos({
        page: Number(u.searchParams.get('page')) || 1,
        size: Number(u.searchParams.get('size')) || 50,
        q: u.searchParams.get('q') || undefined,
        volume: u.searchParams.get('volume') || undefined,
        type: u.searchParams.get('type') || undefined,
      }),
      volumes: listVolumes(),
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/downloads') {
    json(res, 200, {
      ok: true,
      ...listDownloads({
        status: u.searchParams.get('status') || undefined,
        site: u.searchParams.get('site') || undefined,
        q: u.searchParams.get('q') || undefined,
        page: Number(u.searchParams.get('page')) || 1,
        size: Number(u.searchParams.get('size')) || 50,
      }),
    });
    return;
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/stream/')) {
    await streamFile(req, res, Number(pathname.slice(8)));
    return;
  }

  json(res, 404, { ok: false, error: 'not found' });
}

// ---------------------------------------------------------------- 工具

/** @param {http.ServerResponse} res @param {number} code @param {any} data */
function json(res, code, data) {
  const buf = Buffer.from(JSON.stringify(data));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

/**
 * @param {http.IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(/** @type {Error} */ (e)); }
    });
    req.on('error', reject);
  });
}

/**
 * Range 流式播放 files.id 对应文件。
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {number} id
 */
async function streamFile(req, res, id) {
  if (!Number.isInteger(id) || id <= 0) { json(res, 400, { ok: false, error: 'bad id' }); return; }
  const row = /** @type {any} */ (db.prepare('SELECT path, size, ext FROM files WHERE id = ?').get(id));
  if (!row) { json(res, 404, { ok: false, error: '文件不在库中（可能已被扫描清理）' }); return; }
  let size = row.size;
  try {
    const st = await fs.stat(row.path); // 库中 size 可能滞后，以实盘为准
    size = st.size;
  } catch {
    json(res, 404, { ok: false, error: '文件已不存在于磁盘' });
    return;
  }
  const mime = row.ext === 'ts' ? 'video/mp2t' : row.ext === 'webp' ? 'image/webp'
    : row.ext === 'png' ? 'image/png' : row.ext === 'jpg' || row.ext === 'jpeg' ? 'image/jpeg'
    : 'video/mp4';

  const range = String(req.headers.range || '');
  const m = range.match(/^bytes=(\d*)-(\d*)$/);
  /** @type {{ start: number, end: number } | null} */
  let seg = null;
  if (m && (m[1] || m[2])) {
    const total = size - 1;
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[2] ? Math.min(total, Number(m[2])) : total;
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    seg = { start, end };
  }

  const headers = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (seg) {
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${seg.start}-${seg.end}/${size}`, 'Content-Length': String(seg.end - seg.start + 1) });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(row.path, { start: seg.start, end: seg.end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': String(size) });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(row.path).pipe(res);
  }
}

server.listen(PORT, HOST, () => {
  console.log(`[media-server] http://${HOST}:${PORT} （媒体库 ${path.join(ROOT, 'media.db')}）`);
});
