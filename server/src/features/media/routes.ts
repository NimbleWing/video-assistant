// 媒体库 API 路由：/api/videos、/api/files、/api/exists、/api/scan、/api/config、
// /stream/:id（Range 直连）、/stream/:id/index.m3u8 + /seg/:seg（HLS 流）。
import { promises as fs } from 'node:fs';
import { asRecord, HttpError, json, readJson, type Route } from '../../lib/http.ts';
import { ffmpegInfo, getFfmpegPath, resetFfmpegProbe, setFfmpegPath } from '../../lib/hls-core.ts';
import { findDownloadedHit } from '../ledger/downloads.ts';
import { listVideos, listVolumes, queryExists, setFileDuration, upsertFileRecorded } from './files.ts';
import { hlsManifestHandler, hlsSegmentHandler } from './hls.ts';
import { mp4Duration } from './mp4.ts';
import { scanAll, saveScanDirs, scanDirs } from './scanner.ts';
import { streamHandler } from './stream.ts';
import type { ConfigResponse, ScanResponse, VideosResponse } from './types.ts';

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

// 判定：账本优先（complete/skipped 即「已在本地」，vid 精确 → filename 回退），
// 未命中走 files（磁盘扫描实况）。账本命中时 matches 首位带账本 filename（相对路径）。
const existsRoute: Route['handler'] = ({ res, url }) => {
  const rel = url.searchParams.get('rel') ?? url.searchParams.get('name') ?? '';
  const vid = url.searchParams.get('vid') ?? '';
  const hit = findDownloadedHit(vid, rel);
  const r = queryExists(rel);
  if (hit) {
    json(res, 200, {
      ok: true,
      exists: true,
      matches: [{ path: hit.filename || rel, type: 'video', size: hit.size ?? 0 }, ...r.matches],
    });
    return;
  }
  json(res, 200, { ok: true, ...r });
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

const getConfigRoute: Route['handler'] = async ({ res }) => {
  const ffmpeg = await ffmpegInfo();
  const body: ConfigResponse = { ok: true, scanDirs: scanDirs(), ffmpegPath: getFfmpegPath(), ffmpeg };
  json(res, 200, body);
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
  // ffmpeg 路径（可选字段）：空串 = 清除配置走 PATH；存在性同样只警告不阻断
  if (body?.ffmpegPath != null) {
    const p = String(body.ffmpegPath).trim();
    if (p) {
      try {
        const st = await fs.stat(p);
        if (!st.isFile()) warnings.push(`${p} 不是文件`);
      } catch {
        warnings.push(`${p} 不存在或不可访问`);
      }
    }
    setFfmpegPath(p);
    resetFfmpegProbe();
  }
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
  { method: 'GET', path: '/stream/:id/index.m3u8', handler: hlsManifestHandler },
  { method: 'HEAD', path: '/stream/:id/index.m3u8', handler: hlsManifestHandler },
  { method: 'GET', path: '/stream/:id/seg/:seg', handler: hlsSegmentHandler },
  { method: 'HEAD', path: '/stream/:id/seg/:seg', handler: hlsSegmentHandler },
];
