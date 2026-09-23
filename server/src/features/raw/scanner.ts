// 原始资料扫描任务：全局单任务 + 作用域化消失判定 + 协作式取消。
// 进度不经监听器分发——SSE 路由以 ~500ms 轮询 rawScanStatus() 快照推送（内存对象读取零成本，天然节流）。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ffmpegInfo, ffmpegProbeMeta, type FfmpegInfo } from '../../lib/hls-core.ts';
import { getMeta, setMeta } from '../../lib/meta.ts';
import { normPath } from '../../lib/paths.ts';
import { HttpError } from '../../lib/http.ts';
import {
  countOtherLiveByHash,
  findRawByPath,
  getRawByPath,
  listScopeDisappeared,
  listUnprobedArchivedVideos,
  listUnprobedVideos,
  markPendingMissing,
  mergeMove,
  setRawVideoMeta,
  touchRawSeen,
  upsertRawScanned,
  rawTypeOfExt,
} from './files.ts';
import { isMpegTsHead, sampleFile } from './hash.ts';
import { rawRootOf } from './volumes.ts';
import type { RawFileRow, RawScanResult, RawScanStatus, RawType } from './types.ts';

interface ScanState {
  volumes: string[];
  types: RawType[];
  startedAt: number;
  currentVolume: string;
  scanned: number;
  videos: number;
  images: number;
  /** 已成功探测元数据的视频数（新建 + 存量补录）。 */
  probed: number;
  cancelRequested: boolean;
  canceled: boolean;
}

/** 扫描作用域：盘符 + 对应 RawFiles 根目录（测试可注入临时目录）。 */
interface ScanScope {
  volume: string;
  root: string;
}

let state: ScanState | null = null;
let lastResult: RawScanResult | null = null;
/** 单调递增的扫描 token：快速连扫可能落在同一毫秒，Date.now() 回退取 last+1 保证严格递增（消失判定依赖 last_seen < token）。 */
let lastToken = 0;

function nextToken(): number {
  lastToken = Math.max(Date.now(), lastToken + 1);
  return lastToken;
}

/** 任务快照（status 端点与 SSE 事件体共用）。 */
export function rawScanStatus(): RawScanStatus {
  if (state) {
    return {
      running: true,
      startedAt: state.startedAt,
      volumes: state.volumes,
      types: state.types,
      currentVolume: state.currentVolume,
      scanned: state.scanned,
      videos: state.videos,
      images: state.images,
      probed: state.probed,
      lastResult: null,
    };
  }
  return { running: false, lastResult };
}

/** 页面恢复上次勾选（meta.raw_last_selection）。 */
export function rawLastSelection(): { volumes: string[]; types: RawType[] } | null {
  try {
    const v = JSON.parse(getMeta('raw_last_selection') ?? 'null') as unknown;
    if (v == null || typeof v !== 'object') return null;
    const volumes = Array.isArray((v as { volumes?: unknown }).volumes)
      ? (v as { volumes: unknown[] }).volumes.map(String).filter((s) => /^[a-z]:$/.test(s))
      : [];
    const types = Array.isArray((v as { types?: unknown }).types)
      ? (v as { types: unknown[] }).types.filter((t): t is RawType => t === 'video' || t === 'image')
      : [];
    return volumes.length && types.length ? { volumes, types } : null;
  } catch {
    return null;
  }
}

/** 请求体校验：盘符数组（x: 形态，去重小写）+ 类型数组（非空子集）。 */
function parseVolumes(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'volumes 应为非空盘符数组');
  const set = new Set<string>();
  for (const v of raw) {
    const s = String(v).trim().toLowerCase();
    if (!/^[a-z]:$/.test(s)) throw new HttpError(400, `非法盘符：${String(v)}`);
    set.add(s);
  }
  return [...set].sort();
}

function parseTypes(raw: unknown): RawType[] {
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'types 应为非空类型数组');
  const set = new Set<RawType>();
  for (const t of raw) {
    if (t !== 'video' && t !== 'image') throw new HttpError(400, `非法类型：${String(t)}`);
    set.add(t);
  }
  return [...set];
}

/**
 * 启动扫描（异步任务）：立即返回。已有任务 → 409；RawFiles 缺失的盘在任务内跳过记 warning。
 * 记忆勾选（raw_last_selection）。
 */
export function startRawScan(volumesRaw: unknown, typesRaw: unknown): void {
  if (state) throw new HttpError(409, '已有扫描任务进行中');
  const volumes = parseVolumes(volumesRaw);
  const types = parseTypes(typesRaw);
  setMeta('raw_last_selection', JSON.stringify({ volumes, types }));
  const st: ScanState = {
    volumes,
    types,
    startedAt: Date.now(),
    currentVolume: '',
    scanned: 0,
    videos: 0,
    images: 0,
    probed: 0,
    cancelRequested: false,
    canceled: false,
  };
  state = st;
  lastResult = null;
  const scopes: ScanScope[] = volumes.map((v) => ({ volume: v, root: rawRootOf(v) }));
  executeScan(scopes, st)
    .then((r) => {
      lastResult = r;
    })
    .catch((e: unknown) => {
      console.error(`[raw] 扫描任务异常: ${e instanceof Error ? e.message : String(e)}`);
    })
    .finally(() => {
      if (state === st) state = null;
    });
}

/** 协作式取消：任务运行中返回 true（文件/目录间查标志位；取消不做消失判定）。 */
export function cancelRawScan(): boolean {
  if (!state) return false;
  state.cancelRequested = true;
  return true;
}

/** 测试入口：绕过盘符解析，直接以 (盘符, 根目录) 对执行完整任务流程。 */
export function scanRawRoots(scopes: ScanScope[], types: RawType[]): Promise<RawScanResult> {
  const st: ScanState = {
    volumes: scopes.map((s) => s.volume),
    types,
    startedAt: Date.now(),
    currentVolume: '',
    scanned: 0,
    videos: 0,
    images: 0,
    probed: 0,
    cancelRequested: false,
    canceled: false,
  };
  return executeScan(scopes, st);
}

/** 任务执行体：逐盘遍历入库（新建/变更视频顺带 ffmpeg 探测元数据）→ 移动/改名配对合并 → 作用域化消失判定 → 存量元数据补录（取消三步都不做）。 */
async function executeScan(scopes: ScanScope[], st: ScanState): Promise<RawScanResult> {
  const t0 = Date.now();
  const token = nextToken();
  const warnings: string[] = [];
  const completed: { volume: string; root: string; type: RawType }[] = [];
  // 视频元数据探测：ffmpeg 可用才启用（扫图片任务不触发 PATH 探测）
  const ff: FfmpegInfo = st.types.includes('video') ? await ffmpegInfo() : { available: false, path: '', source: null };
  let newCount = 0;
  let updatedCount = 0;
  const newPaths: string[] = [];
  for (const sc of scopes) {
    if (st.cancelRequested) {
      st.canceled = true;
      break;
    }
    st.currentVolume = sc.volume;
    try {
      await fs.stat(sc.root);
    } catch {
      warnings.push(`${sc.volume}: RawFiles 目录不存在，已跳过`);
      continue;
    }
    try {
      const r = await walkRoot(sc.root, sc.volume, st, token, newPaths, ff);
      newCount += r.newCount;
      updatedCount += r.updatedCount;
      const rootNorm = normPath(sc.root); // 判定作用域按归一化路径前缀
      for (const t of st.types) completed.push({ volume: sc.volume, root: rootNorm, type: t });
    } catch (e) {
      warnings.push(`${sc.volume}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  let movedCount = 0;
  if (!st.canceled && newPaths.length) {
    movedCount = pairMoves(newPaths, completed, token);
    newCount -= movedCount; // 合并对不是真新增
    updatedCount += movedCount; // 旧行被续命更新
  }
  const missingCount = st.canceled ? 0 : markPendingMissing(completed, token);
  // 存量补录：本次作用域内未探测的现存视频（三键未变走跳过分支的存量行）统一探测一轮；
  // 归档行（Archives 树等扫描根外）单列一轮——单行跟随语义下 path 即当前位置
  if (!st.canceled && ff.available) {
    const roots = new Map<string, { volume: string; root: string }>();
    for (const c of completed) if (c.type === 'video') roots.set(`${c.volume}${c.root}`, c);
    for (const row of listUnprobedVideos([...roots.values()])) {
      if (st.cancelRequested) break;
      await probeVideoMeta(ff, row.id, row.path, st);
    }
    if (!st.cancelRequested) {
      for (const row of listUnprobedArchivedVideos()) {
        if (st.cancelRequested) break;
        await probeVideoMeta(ff, row.id, row.path, st);
      }
    }
  }
  return { ms: Date.now() - t0, newCount, updatedCount, movedCount, missingCount, probedCount: st.probed, warnings, canceled: st.canceled };
}

/** 探测单文件并回填（成功才写库、计数；失败静默留 NULL 待下轮重试）。 */
async function probeVideoMeta(ff: FfmpegInfo, id: number, file: string, st: ScanState): Promise<void> {
  const m = await ffmpegProbeMeta(ff.path, file);
  if (m.duration == null || m.duration <= 0) return;
  setRawVideoMeta(id, { duration: Math.round(m.duration), width: m.width, height: m.height });
  st.probed += 1;
}

/**
 * 移动/改名配对（四条件，宁缺毋错）：同会话内按 hash 分组，恰好 1 消失行 + 1 新建行、
 * 且全库无第三条 missing=0 同 hash 行 → 合并（旧行续命 + 归档 + 事件）；否则回退 pending 流程。
 */
function pairMoves(newPaths: string[], completed: { volume: string; type: RawType }[], token: number): number {
  const disappeared = listScopeDisappeared(completed, token);
  if (!disappeared.length) return 0;
  const disByHash = new Map<string, typeof disappeared>();
  for (const d of disappeared) {
    const arr = disByHash.get(d.hash) ?? [];
    arr.push(d);
    disByHash.set(d.hash, arr);
  }
  const newByHash = new Map<string, RawFileRow[]>();
  for (const p of newPaths) {
    const row = getRawByPath(p);
    if (!row) continue; // 理论不可达：刚 upsert 的行
    const arr = newByHash.get(row.hash) ?? [];
    arr.push(row);
    newByHash.set(row.hash, arr);
  }
  let moved = 0;
  for (const [hash, news] of newByHash) {
    if (news.length !== 1) continue; // 条件①：恰好 1 新建
    const diss = disByHash.get(hash);
    if (!diss || diss.length !== 1) continue; // 条件①：恰好 1 消失
    const old = diss[0] as RawFileRow;
    const nw = news[0] as RawFileRow;
    if (countOtherLiveByHash(hash, [old.id, nw.id]) > 0) continue; // 条件②：全库无第三条同 hash 存活行
    if (mergeMove(old, nw, token).length) moved += 1;
  }
  return moved;
}

/** 递归遍历单盘 RawFiles：逐文件「三键跳过 / 抽样 hash / .ts 嗅探」后入库，新建/变更的视频顺带探测元数据（新建路径累计进 newPaths 供配对）。 */
async function walkRoot(
  root: string,
  vol: string,
  st: ScanState,
  token: number,
  newPaths: string[],
  ff: FfmpegInfo,
): Promise<{ newCount: number; updatedCount: number }> {
  let newCount = 0;
  let updatedCount = 0;
  const stack = [path.resolve(root)];
  while (stack.length) {
    if (st.cancelRequested) return { newCount, updatedCount };
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 无权限/已消失的子目录：静默跳过（根目录失败由外层捕获）
    }
    for (const ent of entries) {
      if (st.cancelRequested) return { newCount, updatedCount };
      if (ent.isDirectory()) {
        stack.push(path.join(dir, ent.name)); // 符号链接/junction 在 Dirent 中非 directory，天然跳过
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).slice(1).toLowerCase();
      const type = rawTypeOfExt(ext);
      if (!type || !st.types.includes(type)) continue;
      const abs = path.join(dir, ent.name);
      let size: number;
      let mtimeMs: number;
      try {
        const s = await fs.stat(abs);
        size = s.size;
        mtimeMs = Math.round(s.mtimeMs);
      } catch {
        continue; // 枚举与 stat 之间消失
      }
      const np = normPath(abs);
      const prev = findRawByPath(np);
      if (prev && prev.size === size && prev.mtime === mtimeMs) {
        // 三键未变：沿用旧 hash，只刷 last_seen（重扫近纯遍历）
        touchRawSeen(np, token);
        updatedCount += 1;
        st.scanned += 1;
        if (type === 'video') st.videos += 1;
        else st.images += 1;
        continue;
      }
      const sample = await sampleFile(abs, size);
      if (!sample) continue; // 读取失败：静默跳过
      if (ext === 'ts' && !isMpegTsHead(sample.head)) continue; // TypeScript 代码文件冒充视频
      const base = ent.name;
      const id = upsertRawScanned({
        path: np,
        hash: sample.hash,
        name: base.slice(0, base.length - ext.length - 1), // 保留原始大小写（展示用）
        ext,
        type,
        size,
        mtime: mtimeMs,
        volume: vol,
        seen: token,
      });
      // 新建/变更的视频顺带探测时长/分辨率（ffmpeg 缺席静默跳过，归档流程兜底）
      if (type === 'video' && ff.available) await probeVideoMeta(ff, id, np, st);
      if (prev) updatedCount += 1;
      else {
        newCount += 1;
        newPaths.push(np);
      }
      st.scanned += 1;
      if (type === 'video') st.videos += 1;
      else st.images += 1;
    }
  }
  return { newCount, updatedCount };
}
