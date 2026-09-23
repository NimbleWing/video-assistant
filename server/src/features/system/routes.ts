// 服务级 API 路由：/api/ping（心跳，聚合 raw+ledger 统计）、/api/log（服务日志尾部）、
// /api/shutdown（面板重启的下半程）、/api/exists（判定：账本→raw 两层）、
// /api/config（ffmpeg_path 配置）。ping/exists 是仅有的跨 feature 聚合点
// （exists/config 于 2026-09-23 随 media feature 退役移入，见 DESIGN.md §1）。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { asRecord, HttpError, json, readJson, type Route } from '../../lib/http.ts';
import { SERVER_ROOT } from '../../lib/db.ts';
import { ffmpegInfo, getFfmpegPath, resetFfmpegProbe, setFfmpegPath } from '../../lib/hls-core.ts';
import { dlStatusCounts, findDownloadedHit } from '../ledger/index.ts';
import { rawStats, rawVideoMatches } from '../raw/index.ts';
import type { ConfigResponse, LogResponse, PingResponse } from './types.ts';

const pingRoute: Route['handler'] = async ({ res }) => {
  const s = rawStats();
  const body: PingResponse = {
    ok: true,
    uptime: Math.round(process.uptime()),
    videos: s.videos,
    covers: s.images,
    downloads: dlStatusCounts(),
    ffmpeg: await ffmpegInfo(),
  };
  json(res, 200, body);
};

// 判定（边界 = 本地物理存在，与来源站点无关）：账本优先（complete/skipped 即「已在本地」，
// vid 精确 → filename 回退）→ raw_files（现存视频行，stem 匹配最初名/最新名）。
// 账本命中时 matches 首位带账本 filename（相对路径）。
const existsRoute: Route['handler'] = ({ res, url }) => {
  const rel = url.searchParams.get('rel') ?? url.searchParams.get('name') ?? '';
  const vid = url.searchParams.get('vid') ?? '';
  const hit = findDownloadedHit(vid, rel);
  const matches = rawVideoMatches(rel).map((m) => ({ ...m, type: 'video' as const }));
  if (hit) {
    matches.unshift({ path: hit.filename || rel, type: 'video', size: hit.size ?? 0 });
    json(res, 200, { ok: true, exists: true, matches });
    return;
  }
  json(res, 200, { ok: true, exists: matches.length > 0, matches });
};

const logRoute: Route['handler'] = async ({ res }) => {
  // 本服务自身日志尾部（native 启动时重定向到 server.log）
  try {
    const text = await fs.readFile(path.join(SERVER_ROOT, 'server.log'), 'utf8');
    const lines = text.trimEnd().split('\n');
    const tail = lines.slice(-200).join('\n');
    const body: LogResponse = { ok: true, lines: tail ? tail.split('\n').length : 0, tail };
    json(res, 200, body);
  } catch {
    const body: LogResponse = { ok: true, lines: 0, tail: '(暂无日志——服务可能由 start.bat 启动，日志在控制台窗口)' };
    json(res, 200, body);
  }
};

const getConfigRoute: Route['handler'] = async ({ res }) => {
  const ffmpeg = await ffmpegInfo();
  const body: ConfigResponse = { ok: true, ffmpegPath: getFfmpegPath(), ffmpeg };
  json(res, 200, body);
};

// 保存 ffmpeg 路径（空串 = 清除配置走 PATH）；存在性只警告不阻断
const saveConfigRoute: Route['handler'] = async ({ req, res }) => {
  const body = asRecord(await readJson(req));
  const p = body?.ffmpegPath != null ? String(body.ffmpegPath).trim() : null;
  if (p == null) throw new HttpError(400, '缺少 ffmpegPath');
  const warnings: string[] = [];
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
  json(res, 200, { ok: true, warnings });
};

/** 退出动作（延迟后执行）；测试经 setExitHandlerForTest 替换为 no-op/spy。 */
let exitHandler: () => void = () => process.exit(0);

/** 仅测试用：替换退出动作，避免集成测试真杀 vitest worker。 */
export function setExitHandlerForTest(fn: () => void): void {
  exitHandler = fn;
}

// 面板重启下半程：响应 200 后延迟 200ms 退出（等响应刷盘；服务无状态，直接 exit 安全）。
// 上半程（确认离线 + native start 拉起）在扩展面板侧编排，避免双实例撞 17321 端口。
const shutdownRoute: Route['handler'] = ({ res }) => {
  json(res, 200, { ok: true });
  setTimeout(exitHandler, 200);
};

export const systemRoutes: Route[] = [
  { method: 'GET', path: '/api/ping', handler: pingRoute },
  { method: 'GET', path: '/api/log', handler: logRoute },
  { method: 'GET', path: '/api/exists', handler: existsRoute },
  { method: 'GET', path: '/api/config', handler: getConfigRoute },
  { method: 'POST', path: '/api/config', handler: saveConfigRoute },
  { method: 'POST', path: '/api/shutdown', handler: shutdownRoute },
];
