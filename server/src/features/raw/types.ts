// 原始资料库领域类型（纯类型文件，server-web 经相对路径 re-export 消费）。

export type RawType = 'video' | 'image';

/** raw_files 表行（原始资料盘点 + 抽样 hash 查重底账）。 */
export interface RawFileRow {
  id: number;
  path: string;
  hash: string;
  /** 最初名字（改名永不更新，供扩展下载查重）。 */
  name: string;
  ext: string;
  type: RawType;
  size: number;
  mtime: number;
  volume: string;
  missing: boolean;
  pending_missing: boolean;
  /** 已归档（发生过移动/改名）。 */
  archived: boolean;
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
  /** 配对合并的移动/改名对数（旧行续命，非真新增）。 */
  movedCount: number;
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

/** 变更日志条目：事件 + 关联的 raw_files 行（行被删则为 null，悬空保留）。 */
export interface RawEventItem {
  id: number;
  kind: 'rename' | 'move';
  result: string;
  created_at: number;
  file: { id: number; path: string; hash: string; name: string; volume: string; size: number } | null;
}

export interface RawEventsResponse {
  ok: boolean;
  total: number;
  items: RawEventItem[];
}

/** 归档文件条目：archived=1 的逻辑文件 + 归档登记（最新名）+ 变更计数。 */
export interface ArchivedItem extends RawFileRow {
  /** 最新名字（raw_archive.name）。 */
  latest_name: string;
  /** 变更事件数。 */
  event_count: number;
}

export interface RawArchivedResponse {
  ok: boolean;
  total: number;
  items: ArchivedItem[];
  volumes: RawVolumeStat[];
}
