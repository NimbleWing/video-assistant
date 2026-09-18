// raw 适配层：/api/raw/file/:id/index.m3u8 + /seg/:seg。
// 时长无 DB 缓存列 → 每次建会话 ffmpeg -i 现探（<1s，会话存活期间不重复）。
import { HttpError, type RouteHandler } from '../../lib/http.ts';
import { ffmpegInfo, ffmpegProbeDuration, openHlsSession, peekHlsSession, serveHlsManifest, serveHlsSegment } from '../../lib/hls-core.ts';
import { getRawFile } from './files.ts';

/** 取会话：已有则复用；否则查行 → ffmpeg 现探时长 → 开会话。 */
async function sessionOf(id: number) {
  const cached = peekHlsSession(`raw-${id}`);
  if (cached) return cached;
  const row = getRawFile(id);
  if (!row) throw new HttpError(404, '文件不在库中');
  if (row.type !== 'video') throw new HttpError(400, '仅视频支持 HLS 流');
  const ff = await ffmpegInfo();
  if (!ff.available) throw new HttpError(503, 'ffmpeg 不可用（HLS 流需要；可在设置页配置路径）');
  const probed = await ffmpegProbeDuration(ff.path, row.path);
  if (probed == null || probed <= 0) throw new HttpError(500, '无法解析视频时长');
  return openHlsSession(`raw-${id}`, row.path, probed);
}

export const rawManifestHandler: RouteHandler = async ({ req, res, params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'bad id');
  const s = await sessionOf(id);
  serveHlsManifest(s, req, res);
};

export const rawSegmentHandler: RouteHandler = async ({ req, res, params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'bad id');
  const s = await sessionOf(id);
  await serveHlsSegment(s, String(params.seg ?? ''), req, res);
};
