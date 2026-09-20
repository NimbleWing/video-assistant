// 服务级 API 路由：/api/ping（心跳，聚合 media+ledger 统计）、/api/log（服务日志尾部）、
// /api/shutdown（面板重启的下半程）。ping 是唯一允许的跨 feature 聚合点。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { json, type Route } from '../../lib/http.ts';
import { SERVER_ROOT } from '../../lib/db.ts';
import { ffmpegInfo } from '../../lib/hls-core.ts';
import { mediaStats } from '../media/index.ts';
import { dlStatusCounts } from '../ledger/index.ts';
import type { LogResponse, PingResponse } from './types.ts';

const pingRoute: Route['handler'] = async ({ res }) => {
  const s = mediaStats();
  const body: PingResponse = {
    ok: true,
    uptime: Math.round(process.uptime()),
    videos: s.videos,
    covers: s.covers,
    downloads: dlStatusCounts(),
    ffmpeg: await ffmpegInfo(),
  };
  json(res, 200, body);
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
  { method: 'POST', path: '/api/shutdown', handler: shutdownRoute },
];
