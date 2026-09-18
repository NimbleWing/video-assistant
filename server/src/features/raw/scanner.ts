// 原始资料扫描任务：全局单任务 + 作用域化消失判定 + 协作式取消。
// 进度不经监听器分发——SSE 路由以 ~500ms 轮询 rawScanStatus() 快照推送（内存对象读取零成本，天然节流）。
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getMeta, setMeta } from '../../lib/meta.ts';
import { normPath } from '../../lib/paths.ts';
import { HttpError } from '../../lib/http.ts';
import { findRawByPath, markPendingMissing, touchRawSeen, upsertRawScanned, rawTypeOfExt } from './files.ts';
import { isMpegTsHead, sampleFile } from './hash.ts';
import { rawRootOf } from './volumes.ts';
import type { RawScanResult, RawScanStatus, RawType } from './types.ts';

interface ScanState {
  volumes: string[];
  types: RawType[];
  startedAt: number;
  currentVolume: string;
  scanned: number;
  videos: number;
  images: number;
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
    cancelRequested: false,
    canceled: false,
  };
  return executeScan(scopes, st);
}

/** 任务执行体：逐盘遍历入库，正常完成后做作用域化消失判定（取消不判）。 */
async function executeScan(scopes: ScanScope[], st: ScanState): Promise<RawScanResult> {
  const t0 = Date.now();
  const token = t0;
  const warnings: string[] = [];
  const completed: { volume: string; type: RawType }[] = [];
  let newCount = 0;
  let updatedCount = 0;
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
      const r = await walkRoot(sc.root, sc.volume, st, token);
      newCount += r.newCount;
      updatedCount += r.updatedCount;
      for (const t of st.types) completed.push({ volume: sc.volume, type: t });
    } catch (e) {
      warnings.push(`${sc.volume}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const missingCount = st.canceled ? 0 : markPendingMissing(completed, token);
  return { ms: Date.now() - t0, newCount, updatedCount, missingCount, warnings, canceled: st.canceled };
}

/** 递归遍历单盘 RawFiles：逐文件「三键跳过 / 抽样 hash / .ts 嗅探」后入库。 */
async function walkRoot(root: string, vol: string, st: ScanState, token: number): Promise<{ newCount: number; updatedCount: number }> {
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
      upsertRawScanned({
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
      if (prev) updatedCount += 1;
      else newCount += 1;
      st.scanned += 1;
      if (type === 'video') st.videos += 1;
      else st.images += 1;
    }
  }
  return { newCount, updatedCount };
}
