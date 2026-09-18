// 媒体库 API 路由：/api/videos、/api/files、/api/exists、/api/scan、/api/config、/stream/:id。
import { promises as fs } from 'node:fs';
import { asRecord, HttpError, json, readJson, type Route } from '../../lib/http.ts';
import { listVideos, listVolumes, queryExists, setFileDuration, upsertFileRecorded } from './files.ts';
import { mp4Duration } from './mp4.ts';
import { scanAll, saveScanDirs, scanDirs } from './scanner.ts';
import { streamHandler } from './stream.ts';
import type { ScanResponse, VideosResponse } from './types.ts';

const listVideosRoute: Route['handler'] = async ({ res, url }) => {
  const r = listVideos({
    page: Number(url.searchParams.get('page')) || 1,
    size: Number(url.searchParams.get('size')) || 50,
    q: url.searchParams.get('q') ?? undefined,
    volume: url.searchParams.get('volume') ?? undefined,
    type: url.searchParams.get('type') ?? undefined,
  });
  // 惰性补时长：当前页 mp4 视频无时长则解析并回写（存量渐进补齐，幂等）
  for (const it of r.items) {
    if (it.duration == null && it.type === 'video' && it.ext === 'mp4') {
      const d = await mp4Duration(it.path);
      if (d != null) {
        it.duration = d;
        setFileDuration(it.id, d);
      }
    }
  }
  const body: VideosResponse = { ok: true, ...r, volumes: listVolumes() };
  json(res, 200, body);
};

const existsRoute: Route['handler'] = ({ res, url }) => {
  const rel = url.searchParams.get('rel') ?? url.searchParams.get('name') ?? '';
  json(res, 200, { ok: true, ...queryExists(rel) });
};

const recordFileRoute: Route['handler'] = async ({ req, res }) => {
  const body = asRecord(await readJson(req));
  if (!body?.absPath) throw new HttpError(400, '缺少 absPath');
  const absPath = String(body.absPath);
  const ext = absPath.split('.').pop() ?? '';
  // 登记时解析 mp4 时长（moov 置尾/largesize 均兼容）；.ts 无全局时长头
  let duration = body.duration != null ? Number(body.duration) || undefined : undefined;
  if (duration == null && ext.toLowerCase() === 'mp4') {
    const d = await mp4Duration(absPath);
    if (d != null) duration = d;
  }
  upsertFileRecorded({
    path: absPath,
    size: body.size != null ? Number(body.size) || 0 : 0,
    videoId: body.videoId != null ? String(body.videoId) : undefined,
    duration,
  });
  json(res, 200, { ok: true });
};

const scanRoute: Route['handler'] = async ({ res }) => {
  const body = { ok: true, result: await scanAll() } satisfies ScanResponse;
  json(res, 200, body);
};

const getConfigRoute: Route['handler'] = ({ res }) => {
  json(res, 200, { ok: true, scanDirs: scanDirs() });
};

const saveConfigRoute: Route['handler'] = async ({ req, res }) => {
  const body = asRecord(await readJson(req));
  const raw = body?.scanDirs;
  const dirs = Array.isArray(raw) ? raw.map((d) => String(d).trim()).filter(Boolean) : null;
  if (!dirs) throw new HttpError(400, 'scanDirs 应为数组');
  // 逐个校验目录存在性，收集警告但不阻断保存
  const warnings: string[] = [];
  for (const d of dirs) {
    try {
      const st = await fs.stat(d);
      if (!st.isDirectory()) warnings.push(`${d} 不是目录`);
    } catch {
      warnings.push(`${d} 不存在或不可访问`);
    }
  }
  saveScanDirs(dirs);
  json(res, 200, { ok: true, warnings });
};

export const mediaRoutes: Route[] = [
  { method: 'GET', path: '/api/videos', handler: listVideosRoute },
  { method: 'GET', path: '/api/exists', handler: existsRoute },
  { method: 'POST', path: '/api/files', handler: recordFileRoute },
  { method: 'POST', path: '/api/scan', handler: scanRoute },
  { method: 'GET', path: '/api/config', handler: getConfigRoute },
  { method: 'POST', path: '/api/config', handler: saveConfigRoute },
  { method: 'GET', path: '/stream/:id', handler: streamHandler },
  { method: 'HEAD', path: '/stream/:id', handler: streamHandler },
];
