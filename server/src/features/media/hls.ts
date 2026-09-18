// media 适配层：/stream/:id/index.m3u8 + /stream/:id/seg/:seg。
// 职责仅剩：files.id 查行 → 时长来源（DB 缓存，缺失则 ffmpeg -i 现探并回写）→ lib/hls-core 会话与应答。
// 状态机/ffmpeg 探测均在 lib/hls-core.ts（raw feature 共用），设计见 DESIGN.md §7。
import { type RouteHandler } from '../../lib/http.ts';
import { HttpError } from '../../lib/http.ts';
import { ffmpegInfo, ffmpegProbeDuration, openHlsSession, peekHlsSession, serveHlsManifest, serveHlsSegment } from '../../lib/hls-core.ts';
import { getFileBasic, setFileDuration } from './files.ts';

/** 取会话：已有则复用（跳过查表与时长探测）；否则查行 → 时长（DB 缓存兜底现探）→ 开会话。 */
async function sessionOf(id: number) {
  const cached = peekHlsSession(`m${id}`);
  if (cached) return cached;
  const row = getFileBasic(id);
  if (!row) throw new HttpError(404, '文件不在库中（可能已被扫描清理）');
  if (row.type !== 'video') throw new HttpError(400, '仅视频支持 HLS 流');
  let duration = row.duration;
  if (duration == null || duration <= 0) {
    const ff = await ffmpegInfo();
    if (!ff.available) throw new HttpError(503, 'ffmpeg 不可用（HLS 流需要；可在设置页配置路径）');
    const probed = await ffmpegProbeDuration(ff.path, row.path);
    if (probed == null || probed <= 0) throw new HttpError(500, '无法解析视频时长');
    duration = probed;
    setFileDuration(id, probed);
  }
  return openHlsSession(`m${id}`, row.path, duration);
}

export const hlsManifestHandler: RouteHandler = async ({ req, res, params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'bad id');
  const s = await sessionOf(id);
  serveHlsManifest(s, req, res);
};

export const hlsSegmentHandler: RouteHandler = async ({ req, res, params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'bad id');
  const s = await sessionOf(id);
  await serveHlsSegment(s, String(params.seg ?? ''), req, res);
};
