// 原始资料库领域类型（纯类型文件，server-web 经相对路径 re-export 消费）。

export type RawType = 'video' | 'image';

/** raw_files 表行（原始资料盘点 + 抽样 hash 查重底账）。 */
export interface RawFileRow {
  id: number;
  path: string;
  hash: string;
  name: string;
  ext: string;
  type: RawType;
  size: number;
  mtime: number;
  volume: string;
  missing: boolean;
  pending_missing: boolean;
  first_seen: number;
  last_seen: number;
}

/** 探测到的原始资料盘符（根下存在 RawFiles/ 目录）。 */
export interface RawVolume {
  volume: string;
  total: number;
  free: number;
}

export interface RawVolumesResponse {
  ok: boolean;
  volumes: RawVolume[];
  /** 上次扫描的盘符 + 类型勾选（meta 记忆，无则 null）。 */
  lastSelection: { volumes: string[]; types: RawType[] } | null;
}

/** 库内盘符统计（文件列表筛选用）。 */
export interface RawVolumeStat {
  volume: string;
  files: number;
  videos: number;
  images: number;
}

export interface RawFilesResponse {
  ok: boolean;
  total: number;
  items: RawFileRow[];
  volumes: RawVolumeStat[];
}

/** 一次扫描任务的结果摘要（保留到下次启动）。 */
export interface RawScanResult {
  ms: number;
  newCount: number;
  updatedCount: number;
  /** 全部待决策消失数（含历史未决策）。 */
  missingCount: number;
  warnings: string[];
  canceled: boolean;
}

/** 任务快照（/api/raw/scan/status 与 SSE 事件体）。 */
export interface RawScanStatus {
  running: boolean;
  startedAt?: number;
  volumes?: string[];
  types?: RawType[];
  currentVolume?: string;
  scanned?: number;
  videos?: number;
  images?: number;
  lastResult?: RawScanResult | null;
}

export interface RawScanStartResponse {
  ok: boolean;
  started: boolean;
}

export interface RawScanCancelResponse {
  ok: boolean;
  canceled: boolean;
}

/** GET /api/raw/scan/status 响应（ok 字段由路由层拼接）。 */
export type RawScanStatusResponse = { ok: boolean } & RawScanStatus;

export interface RawMissingResponse {
  ok: boolean;
  items: RawFileRow[];
}

export type RawResolveOp = 'delete' | 'mark';

export interface RawResolveResponse {
  ok: boolean;
  affected: number;
}
