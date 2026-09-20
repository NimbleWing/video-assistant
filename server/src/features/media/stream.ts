// /stream/:id：files.id 的 Range 流式播放（<video> 直接用）。
import { promises as fs } from 'node:fs';
import { HttpError, streamFile, type RouteHandler } from '../../lib/http.ts';
import { getFileBasic } from './files.ts';

export const streamHandler: RouteHandler = async ({ req, res, params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'bad id');
  const row = getFileBasic(id);
  if (!row) throw new HttpError(404, '文件不在库中（可能已被扫描清理）');
  let size = row.size;
  try {
    const st = await fs.stat(row.path); // 库中 size 可能滞后，以实盘为准
    size = st.size;
  } catch {
    throw new HttpError(404, '文件已不存在于磁盘');
  }
  const mime = row.ext === 'ts' ? 'video/mp2t'
    : row.ext === 'webp' ? 'image/webp'
    : row.ext === 'png' ? 'image/png'
    : row.ext === 'jpg' || row.ext === 'jpeg' ? 'image/jpeg'
    : 'video/mp4';

  const range = String(req.headers.range ?? '');
  const m = range.match(/^bytes=(\d*)-(\d*)$/);
  let seg: { start: number; end: number } | null = null;
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

  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (seg) {
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${seg.start}-${seg.end}/${size}`, 'Content-Length': String(seg.end - seg.start + 1) });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    streamFile(res, row.path, { start: seg.start, end: seg.end });
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': String(size) });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    streamFile(res, row.path);
  }
};
