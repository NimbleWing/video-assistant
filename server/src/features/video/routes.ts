// 作品 API 路由：POST /api/videos/archive（原始资料页归档流）+ GET /api/works（作品列表，视频库页地基）。
// 归档流程：校验 → 目标目录（第一个演员的目录树）→ 命名 stem（番号 标题 副标题，空段跳过）
// → 冲突 409 预检 → archiveRawFileTo 双文件移动 → 尽力回填时长（ffmpeg 可用才探测）
// → insertVideo 事务落库。
import { promises as fs } from 'node:fs';
import { asRecord, HttpError, json, readJson, type Route } from '../../lib/http.ts';
import { ffmpegInfo, ffmpegProbeDuration } from '../../lib/hls-core.ts';
import { dirName } from '../../lib/paths.ts';
import { getActress } from '../actress/actresses.ts';
import { archiveRawFileTo, getRawFile, setRawDuration } from '../raw/files.ts';
import { insertVideo, listVideos } from './videos.ts';

const TITLE_MAX = 120;

const listRoute: Route['handler'] = ({ res, url }) => {
  const r = listVideos({
    page: Number(url.searchParams.get('page')) || 1,
    size: Number(url.searchParams.get('size')) || 50,
    q: url.searchParams.get('q') ?? undefined,
    kind: (url.searchParams.get('kind') as 'single' | 'series' | null) ?? undefined,
    actressId: Number(url.searchParams.get('actressId')) || undefined,
    tagId: Number(url.searchParams.get('tagId')) || undefined,
    studioId: Number(url.searchParams.get('studioId')) || undefined,
  });
  json(res, 200, { ok: true, ...r });
};

const archiveRoute: Route['handler'] = async ({ req, res }) => {
  const body = asRecord(await readJson(req));
  const title = String(body?.title ?? '').trim();
  if (!title) throw new HttpError(400, '标题不能为空');
  if (title.length > TITLE_MAX) throw new HttpError(400, `标题过长（≤${TITLE_MAX} 字符）`);
  const kind = String(body?.kind ?? 'single');
  if (kind !== 'single') throw new HttpError(400, '剧集归档待后续迭代（kind 仅支持 single）');

  const actressIds = Array.isArray(body?.actressIds) ? body.actressIds.map((v) => Number(v)) : [];
  if (!actressIds.length || !actressIds.every((n) => Number.isInteger(n) && n > 0)) throw new HttpError(400, '归档需要至少一位演员');
  const countryId = Number(body?.countryId);
  if (!Number.isInteger(countryId) || countryId <= 0) throw new HttpError(400, '缺少国家或国家 id 非法');

  const fileId = Number(body?.fileId);
  if (!Number.isInteger(fileId) || fileId <= 0) throw new HttpError(400, '缺少 fileId');
  const videoRow = getRawFile(fileId);
  if (!videoRow) throw new HttpError(404, '视频文件不存在');
  if (videoRow.type !== 'video') throw new HttpError(400, '仅视频可归档');

  let coverFileId: number | null = null;
  let coverRow = null;
  if (body?.coverFileId != null) {
    coverFileId = Number(body.coverFileId);
    if (!Number.isInteger(coverFileId) || coverFileId <= 0) throw new HttpError(400, 'coverFileId 非法');
    coverRow = getRawFile(coverFileId);
    if (!coverRow) throw new HttpError(404, '封面文件不存在');
    if (coverRow.type !== 'image') throw new HttpError(400, '封面必须是图片');
    if (coverFileId === fileId) throw new HttpError(400, '封面不能是视频本身');
  }

  // 第一个演员 → 归档落点（她的目录树：{盘}/Archives/{她的国家}/{她}/；表单国家仅元数据）
  const first = getActress(actressIds[0]!);
  if (!first) throw new HttpError(400, '第一位演员不存在');
  const firstCountry = first.country_name ? dirName(first.country_name) : 'unnamed';
  const dir = `${first.disk}/Archives/${firstCountry}/${dirName(first.name)}`;

  // 命名 stem：有番号「{番号} {标题} {副标题}」/ 无番号「{标题} {副标题}」
  // （先滤空段再清洗——dirName 对空串按契约回退 'unnamed'，顺序反了会把空段填成 unnamed）
  const code = body?.code != null ? String(body.code).trim() : '';
  const subtitle = body?.subtitle != null ? String(body.subtitle).trim() : '';
  const stem = [code, title, subtitle].filter(Boolean).map((s) => dirName(s)).filter(Boolean).join(' ');
  if (!stem) throw new HttpError(400, '命名段清洗后为空');

  // 冲突预检（视频与封面同 stem 不同扩展；已存在同名 → 409 防误覆盖）
  for (const ext of new Set([videoRow.ext, coverRow?.ext].filter(Boolean) as string[])) {
    const target = `${dir}/${stem}.${ext}`;
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    try {
      await fs.access(target);
      throw new HttpError(409, `目标已存在同名文件：${target}`);
    } catch (e) {
      if (e instanceof HttpError) throw e; // access 命中（存在）→ 冲突；ENOENT → 继续
    }
  }

  // 双文件归档移动（行跟随 + 事件）；之后才写库（失败时文件已被移回原位）
  await archiveRawFileTo(fileId, `${dir}/${stem}.${videoRow.ext}`);
  if (coverRow) await archiveRawFileTo(coverFileId!, `${dir}/${stem}.${coverRow.ext}`);

  // 时长回填（尽力而为：ffmpeg 缺失/探测失败静默跳过，不阻断归档；<1s）
  const ff = await ffmpegInfo();
  if (ff.available) {
    const dur = await ffmpegProbeDuration(ff.path, `${dir}/${stem}.${videoRow.ext}`);
    if (dur != null && dur > 0) setRawDuration(fileId, Math.round(dur));
  }

  const item = insertVideo({
    kind: 'single',
    title,
    subtitle: subtitle || null,
    code: code || null,
    videoFileId: fileId,
    coverFileId,
    actressIds,
    tagIds: Array.isArray(body?.tagIds) ? body.tagIds.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0) : [],
    studioId: body?.studioId != null && Number(body.studioId) > 0 ? Number(body.studioId) : null,
    countryId,
  });
  json(res, 200, { ok: true, item });
};

export const videoRoutes: Route[] = [
  // 历史注记：GET /api/videos 曾被已退役的 media feature 占用，作品域沿用 /api/works
  { method: 'GET', path: '/api/works', handler: listRoute },
  { method: 'POST', path: '/api/videos/archive', handler: archiveRoute },
];
