// HLS 流播放：/stream/:id/index.m3u8 + /stream/:id/seg/:n.ts。
// ffmpeg -c copy 无损重整按需分段（会话状态机移植自 stash StreamManager，设计见 DESIGN.md §7）。
// remux 产出的 MP4 容器时基有缺陷（无 ctts + 负 PTS 差被钳），Chrome 直连播丢帧抖动；
// 经 ffmpeg 重整为 MPEG-TS 分段后时间轴健康。ffmpeg 为可选增强：缺失时端点 503，前端降级直连。
import { spawn, type ChildProcess } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getMeta, setMeta } from '../../lib/meta.ts';
import { HttpError, type RouteHandler } from '../../lib/http.ts';
import { getFileBasic, setFileDuration } from './files.ts';

/** 分段时长（秒），与清单 TARGETDURATION 一致。 */
const SEGMENT_SEC = 2;
/** seek 判定阈值：请求段落后当前生成进度超过该值 → 重启进程于目标段。 */
const MAX_SEGMENT_GAP = 5;
/** 预生成上限：请求段起该窗口内段全部就绪 → 停进程（保留文件与会话）。 */
const MAX_SEGMENT_BUFFER = 15;
/** 等待段文件生成超时（ms）。 */
const MAX_SEGMENT_WAIT = 15_000;
/** 会话空闲回收（ms）：杀进程 + 删分段目录。 */
const MAX_IDLE = 30_000;
/** monitor tick 间隔（ms）。 */
const MONITOR_INTERVAL = 200;

/** 分段缓存根（会话目录 = <root>/<files.id>）。 */
export const CACHE_ROOT = path.join(os.tmpdir(), 'rou-media-hls');

// ---------------------------------------------------------------------------
// ffmpeg 探测
// ---------------------------------------------------------------------------

export interface FfmpegInfo {
  available: boolean;
  path: string;
  source: 'config' | 'path' | null;
}

/** PATH 探测结果进程内缓存（ping 30s 轮询不能反复 spawn）。 */
let pathProbe: boolean | null = null;

/** 保存配置后调用：使探测缓存失效。 */
export function resetFfmpegProbe(): void {
  pathProbe = null;
}

/** 用户配置的 ffmpeg 路径（meta.ffmpeg_path；空串/null = 未配置，走 PATH）。 */
export function getFfmpegPath(): string {
  return (getMeta('ffmpeg_path') ?? '').trim();
}

export function setFfmpegPath(p: string): void {
  setMeta('ffmpeg_path', p.trim());
}

function probeOnPath(): Promise<boolean> {
  if (pathProbe != null) return Promise.resolve(pathProbe);
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
    proc.on('error', () => {
      pathProbe = false;
      resolve(false);
    });
    proc.on('exit', (code) => {
      pathProbe = code === 0;
      resolve(pathProbe);
    });
  });
}

/** ffmpeg 探测：配置路径优先（须存在且为文件），其次 PATH。 */
export async function ffmpegInfo(): Promise<FfmpegInfo> {
  const cfg = getFfmpegPath();
  if (cfg) {
    try {
      const st = await fs.stat(cfg);
      if (st.isFile()) return { available: true, path: cfg, source: 'config' };
    } catch { /* 配置路径失效 → 报不可用（不静默回退 PATH，避免误导） */ }
    return { available: false, path: cfg, source: 'config' };
  }
  if (await probeOnPath()) return { available: true, path: 'ffmpeg', source: 'path' };
  return { available: false, path: '', source: null };
}

/**
 * ffmpeg -i 解析时长（stderr `Duration: HH:MM:SS.cc`）——files.duration 缺失时的兜底
 * （如 .ts 透传文件）。无输出参数时 ffmpeg 以退出码 1 结束，属预期。
 */
export function ffmpegProbeDuration(ffmpegPath: string, file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let out = '';
    const timer = setTimeout(() => {
      proc.kill();
      resolve(null);
    }, 10_000);
    proc.stderr.on('data', (c: Buffer) => {
      out = (out + c.toString('utf8')).slice(-65536);
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on('exit', () => {
      clearTimeout(timer);
      const m = out.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null);
    });
  });
}

// ---------------------------------------------------------------------------
// 纯函数：清单 / 参数 / 段号（供测试）
// ---------------------------------------------------------------------------

/** 清单段数：floor(duration/2)——宁可少承诺尾段（≤2s），不超额承诺引发尾部段超时。 */
export function segmentCount(durationSec: number): number {
  return Math.max(1, Math.floor(durationSec / SEGMENT_SEC));
}

/** 服务端自生成 VOD 清单（段 URL 用相对路径，对开发代理友好）。 */
export function buildManifest(durationSec: number): string {
  const count = segmentCount(durationSec);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXT-X-TARGETDURATION:${SEGMENT_SEC}`,
    '#EXT-X-PLAYLIST-TYPE:VOD',
  ];
  let left = durationSec;
  for (let i = 0; i < count; i++) {
    lines.push(`#EXTINF:${Math.min(SEGMENT_SEC, Math.max(0.001, left)).toFixed(6)},`);
    lines.push(`seg/${i}.ts`);
    left -= SEGMENT_SEC;
  }
  lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/** '131.ts' → 131；不合法返回 null。 */
export function parseSegmentParam(seg: string): number | null {
  const m = seg.match(/^(\d+)\.ts$/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * ffmpeg 分段参数（对齐 stash 默认 HLS 转码配方）：
 * - **转码而非 copy**：源 MP4 无 ctts、DTS 缺失，copy 重整无法修复帧级合成时间轴
 *   （TS 只带锯齿 PTS、段头丢帧，MSE 丢帧更狠）；libx264 重建全新时间轴并输出 DTS。
 * - input 侧 -ss 定位重启段；-copyts 保持原始时间轴，seek 重启后段 PTS 与全局 2s 网格对齐；
 * - force_key_frames 每 2s 全局网格强关键帧 + split_by_time 精确切分：段起始必为关键帧、段数与清单吻合；
 * - 音频转 AAC：编码器输出完整 ADTS 帧，避免 copy 模式跨段切割 AAC 帧产生破音。
 */
export function buildFfmpegArgs(file: string, segment: number, dir: string): string[] {
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (segment > 0) args.push('-ss', String(segment * SEGMENT_SEC));
  args.push(
    '-i', file,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-sc_threshold', '0',
    '-force_key_frames', 'expr:gte(t,n_forced*2)',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-sn', '-dn', '-copyts', '-avoid_negative_ts', 'disabled',
    '-f', 'hls',
    '-start_number', String(segment),
    '-hls_time', String(SEGMENT_SEC),
    '-hls_flags', 'split_by_time',
    '-hls_segment_type', 'mpegts',
    '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(dir, '.%d.ts'),
    path.join(dir, 'manifest.m3u8'),
  );
  return args;
}

// ---------------------------------------------------------------------------
// 会话状态机
// ---------------------------------------------------------------------------

interface Waiter {
  idx: number;
  file: string;
  accessedAt: number;
  done: boolean;
  resolve: (err: string | null) => void;
}

interface Session {
  id: number;
  dir: string;
  file: string;
  ffmpegPath: string;
  duration: number;
  proc: ChildProcess | null;
  /** 最近确认的段号（生成进度线；临时段 `.{i}.ts` 出现 = 第 i-1 段完整）。 */
  procSegment: number;
  procExited: boolean;
  procExitOk: boolean;
  lastAccessed: number;
  lastSegment: number;
  waiting: Waiter[];
}

const sessions = new Map<number, Session>();
let timer: NodeJS.Timeout | null = null;

/** 服务启动时清空缓存根（上次残留进程的分段自杀清理）。测试不调用。 */
export function initHlsCache(): void {
  fs.rm(CACHE_ROOT, { recursive: true, force: true }).catch(() => {});
}

/** 停 monitor、杀全部进程、清会话表（测试收尾用；不删磁盘目录）。 */
export function disposeHls(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  for (const s of sessions.values()) forceStop(s);
  sessions.clear();
}

/** 取/建会话：文件在库且在盘、ffmpeg 可用、时长可解析（缺失则 ffmpeg -i 探测并回写 DB）。 */
async function getSession(id: number): Promise<Session> {
  const existing = sessions.get(id);
  if (existing) {
    existing.lastAccessed = Date.now();
    return existing;
  }
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'bad id');
  const row = getFileBasic(id);
  if (!row) throw new HttpError(404, '文件不在库中（可能已被扫描清理）');
  if (row.type !== 'video') throw new HttpError(400, '仅视频支持 HLS 流');
  try {
    await fs.stat(row.path);
  } catch {
    throw new HttpError(404, '文件已不存在于磁盘');
  }
  const ff = await ffmpegInfo();
  if (!ff.available) throw new HttpError(503, 'ffmpeg 不可用（HLS 流需要；可在设置页配置路径）');
  let duration = row.duration;
  if (duration == null || duration <= 0) {
    const probed = await ffmpegProbeDuration(ff.path, row.path);
    if (probed == null || probed <= 0) throw new HttpError(500, '无法解析视频时长');
    duration = probed;
    setFileDuration(id, probed);
  }
  const s: Session = {
    id,
    dir: path.join(CACHE_ROOT, String(id)),
    file: row.path,
    ffmpegPath: ff.path,
    duration,
    proc: null,
    procSegment: 0,
    procExited: true,
    procExitOk: false,
    lastAccessed: Date.now(),
    lastSegment: 0,
    waiting: [],
  };
  sessions.set(id, s);
  ensureMonitor();
  return s;
}

/** 杀进程信号：proc 由退出事件清理（避免旧进程未死、新进程争写同名临时段）。 */
function killProc(s: Session): void {
  s.proc?.kill();
}

/** 立即清（仅回收/销毁路径）：会话即将消亡，不等退出事件。 */
function forceStop(s: Session): void {
  const p = s.proc;
  s.proc = null;
  s.procExited = true;
  s.procExitOk = false;
  p?.kill();
}

function startTranscode(s: Session, segment: number): void {
  mkdirSync(s.dir, { recursive: true });
  const proc = spawn(s.ffmpegPath, buildFfmpegArgs(s.file, segment, s.dir), {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  s.proc = proc;
  s.procSegment = segment;
  s.procExited = false;
  s.procExitOk = false;
  let errTail = '';
  proc.stderr.on('data', (c: Buffer) => {
    if (errTail.length < 8192) errTail += c.toString('utf8');
  });
  const onEnd = (ok: boolean) => {
    if (s.proc !== proc) return; // 已被 stopProc 接管（seek 重启/回收）
    s.procExited = true;
    s.procExitOk = ok;
    checkSegments(s); // 退出收尾：末段转正或删除
    s.proc = null;
    if (!ok && errTail.trim()) console.error(`[hls] ffmpeg 退出（file=${s.file} seg=${segment}）: ${errTail.trim().split('\n').pop()}`);
  };
  proc.on('error', () => onEnd(false));
  proc.on('exit', (code) => onEnd(code === 0));
}

/** 段确认：从 procSegment 起扫临时段 `.{i}.ts`——出现即证明上一段完整，改名转正（不覆盖已有）。 */
function checkSegments(s: Session): void {
  let lastTemp = '';
  for (let i = s.procSegment; ; i++) {
    const temp = path.join(s.dir, `.${i}.ts`);
    if (existsSync(temp)) {
      promote(s, lastTemp);
    } else {
      if (s.procExited) {
        if (s.procExitOk) promote(s, lastTemp);
        else if (lastTemp) rmSync(lastTemp, { force: true }); // 失败退出：末段可能不完整
      }
      break;
    }
    lastTemp = temp;
    s.procSegment = i;
  }
}

/** 临时段转正：`.{n}.ts` → `{n}.ts`；已存在（重启后重复生成）则丢弃新文件。 */
function promote(_s: Session, temp: string): void {
  if (!temp) return;
  const base = path.basename(temp);
  const fin = path.join(path.dirname(temp), base.slice(1));
  try {
    if (!existsSync(fin)) renameSync(temp, fin);
    else rmSync(temp, { force: true });
  } catch { /* 并发竞态兜底：留待下轮 */ }
}

/** 按需起进程：无进程 → 从目标段起；请求段跳变（seek）→ 杀进程（下一 tick 再起新进程）。 */
function ensureTranscode(s: Session, idx: number): boolean {
  if (!s.proc) {
    startTranscode(s, idx);
    return true;
  }
  if (idx < s.procSegment || s.procSegment + MAX_SEGMENT_GAP < idx) {
    killProc(s);
    return true;
  }
  return false;
}

/** 会话回收：空闲 30s → 杀进程删目录；预生成封顶 → 停进程（保留文件）。 */
function checkSession(s: Session, now: number): void {
  if (!s.waiting.length && s.lastAccessed + MAX_IDLE < now) {
    forceStop(s);
    sessions.delete(s.id);
    fs.rm(s.dir, { recursive: true, force: true }).catch(() => {});
    return;
  }
  if (s.proc) {
    for (let i = s.lastSegment; i < s.lastSegment + MAX_SEGMENT_BUFFER; i++) {
      if (!existsSync(path.join(s.dir, `${i}.ts`))) return;
    }
    killProc(s); // 预生成封顶：进程由退出事件清理，会话与文件保留
  }
}

function monitorTick(): void {
  try {
    const now = Date.now();
    for (const s of [...sessions.values()]) {
      if (s.proc) checkSegments(s);
      let started = false;
      const keep: Waiter[] = [];
      for (const w of s.waiting) {
        if (w.done) continue;
        if (existsSync(w.file)) {
          w.done = true;
          w.resolve(null);
        } else if (now - w.accessedAt > MAX_SEGMENT_WAIT) {
          w.done = true;
          w.resolve(`段 ${w.idx} 生成超时`);
        } else if (!started) {
          started = ensureTranscode(s, w.idx);
        }
        if (!w.done) keep.push(w);
      }
      s.waiting = keep;
      if (!started) checkSession(s, now);
    }
    if (!sessions.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  } catch (e) {
    console.error(`[hls] monitor 异常: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function ensureMonitor(): void {
  if (!timer) timer = setInterval(monitorTick, MONITOR_INTERVAL);
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

export const hlsManifestHandler: RouteHandler = async ({ req, res, params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'bad id');
  const s = await getSession(id);
  const body = buildManifest(s.duration);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(req.method === 'HEAD' ? undefined : body);
};

export const hlsSegmentHandler: RouteHandler = async ({ req, res, params }) => {
  const id = Number(params.id);
  const idx = parseSegmentParam(String(params.seg ?? ''));
  if (!Number.isInteger(id) || id <= 0 || idx == null) throw new HttpError(400, 'bad segment');
  const s = await getSession(id);
  if (idx > segmentCount(s.duration) - 1) throw new HttpError(400, 'segment out of range');
  s.lastAccessed = Date.now();
  s.lastSegment = Math.max(s.lastSegment, idx);
  const file = path.join(s.dir, `${idx}.ts`);
  if (!existsSync(file)) {
    await new Promise<string | null>((resolve) => {
      s.waiting.push({ idx, file, accessedAt: Date.now(), done: false, resolve });
    }).then((err) => {
      if (err) throw new HttpError(500, err);
    });
  }
  if (res.destroyed || res.writableEnded) return;
  const st = await fs.stat(file).catch(() => null);
  if (!st) throw new HttpError(500, '段文件丢失');
  res.writeHead(200, {
    'Content-Type': 'video/mp2t',
    'Cache-Control': 'no-store',
    'Content-Length': st.size,
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
};
