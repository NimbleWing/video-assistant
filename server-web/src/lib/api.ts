import type {
  ActressesResponse,
  ActressDisksResponse,
  ActressMutationResponse,
  ActressUpsertRequest,
  ConfigResponse,
  CountriesResponse,
  CountryMutationResponse,
  CountryRow,
  DownloadsResponse,
  LogResponse,
  RawArchivedResponse,
  RawDuplicatesResponse,
  RawEventsResponse,
  RawFileDeleteResponse,
  RawFilesResponse,
  RawMissingResponse,
  RawResolveOp,
  RawResolveResponse,
  RawScanCancelResponse,
  RawScanStartResponse,
  RawScanStatusResponse,
  RawType,
  RawVolumesResponse,
  SaveConfigResponse,
  ScanResponse,
  StudiosResponse,
  StudioMutationResponse,
  TagsResponse,
  TagMutationResponse,
  VideoArchiveRequest,
  VideoMutationResponse,
  VideosResponse,
  WorksResponse,
} from './types';

async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({ ok: false, error: r.statusText }));
  const body = j as { ok?: boolean; error?: string };
  if (!r.ok || body.ok === false) throw new Error(body.error || r.statusText);
  return j as T;
}

export interface VideosQuery {
  page: number;
  size: number;
  q?: string;
  volume?: string;
  type: 'video' | 'cover';
}

export function fetchVideos(query: VideosQuery): Promise<VideosResponse> {
  const p = new URLSearchParams({
    page: String(query.page),
    size: String(query.size),
    type: query.type,
  });
  if (query.q) p.set('q', query.q);
  if (query.volume) p.set('volume', query.volume);
  return api(`/api/videos?${p.toString()}`);
}

export interface DownloadsQuery {
  status?: string;
  site?: string;
  q?: string;
  page: number;
  size: number;
}

export function fetchDownloads(query: DownloadsQuery): Promise<DownloadsResponse> {
  const p = new URLSearchParams({
    page: String(query.page),
    size: String(query.size),
  });
  if (query.status) p.set('status', query.status);
  if (query.site) p.set('site', query.site);
  if (query.q) p.set('q', query.q);
  return api(`/api/downloads?${p.toString()}`);
}

export function fetchConfig(): Promise<ConfigResponse> {
  return api('/api/config');
}

export function saveConfig(scanDirs: string[], ffmpegPath?: string): Promise<SaveConfigResponse> {
  return api('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ffmpegPath == null ? { scanDirs } : { scanDirs, ffmpegPath }),
  });
}

export function triggerScan(): Promise<ScanResponse> {
  return api('/api/scan', { method: 'POST' });
}

export function fetchLog(): Promise<LogResponse> {
  return api('/api/log');
}

// ---------------------------------------------------------------------------
// 国家字典（演员体系基石）
// ---------------------------------------------------------------------------

export function fetchCountries(): Promise<CountriesResponse> {
  return api('/api/countries');
}

export function createCountry(name: string): Promise<CountryMutationResponse> {
  return api('/api/countries', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function renameCountry(id: number, name: string): Promise<CountryMutationResponse> {
  return api(`/api/countries/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function deleteCountry(id: number): Promise<{ ok: boolean }> {
  return api(`/api/countries/${id}/delete`, { method: 'POST' });
}

/** 类型再导出（组件直接用，避免另起 import 线）。 */
export type { CountryRow };

// ---------------------------------------------------------------------------
// 原始资料库（SSE 进度不经此客户端，组件直连 EventSource）
// ---------------------------------------------------------------------------

export function fetchRawVolumes(): Promise<RawVolumesResponse> {
  return api('/api/raw/volumes');
}

export function startRawScan(volumes: string[], types: RawType[]): Promise<RawScanStartResponse> {
  return api('/api/raw/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volumes, types }),
  });
}

export function cancelRawScan(): Promise<RawScanCancelResponse> {
  return api('/api/raw/scan/cancel', { method: 'POST' });
}

export function fetchRawScanStatus(): Promise<RawScanStatusResponse> {
  return api('/api/raw/scan/status');
}

export interface RawFilesQuery {
  page: number;
  size: number;
  q?: string;
  type?: 'video' | 'image';
  volume?: string;
  missing?: 'hide' | 'only' | 'all';
  /** 归档口径：hide=默认（仅未归档）/ only（仅已归档）/ all。 */
  archived?: 'hide' | 'only' | 'all';
}

export function fetchRawFiles(query: RawFilesQuery): Promise<RawFilesResponse> {
  const p = new URLSearchParams({
    page: String(query.page),
    size: String(query.size),
  });
  if (query.q) p.set('q', query.q);
  if (query.type) p.set('type', query.type);
  if (query.volume) p.set('volume', query.volume);
  if (query.missing) p.set('missing', query.missing);
  if (query.archived) p.set('archived', query.archived);
  return api(`/api/raw/files?${p.toString()}`);
}

export function fetchRawMissing(): Promise<RawMissingResponse> {
  return api('/api/raw/missing');
}

export function resolveRawMissing(op: RawResolveOp): Promise<RawResolveResponse> {
  return api('/api/raw/missing/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op }),
  });
}

/** 重复文件分组查询（组为单位分页）。 */
export function fetchRawDuplicates(query: { page: number; size: number }): Promise<RawDuplicatesResponse> {
  const p = new URLSearchParams({
    page: String(query.page),
    size: String(query.size),
  });
  return api(`/api/raw/duplicates?${p.toString()}`);
}

/** 删除磁盘文件 + raw_files 行（查重清理，不可恢复）。 */
export function deleteRawFile(id: number): Promise<RawFileDeleteResponse> {
  return api(`/api/raw/file/${id}/delete`, { method: 'POST' });
}

// ---------------------------------------------------------------------------
// 标签字典（sort 拖拽排序）
// ---------------------------------------------------------------------------

export function fetchTags(): Promise<TagsResponse> {
  return api('/api/tags');
}

export function createTag(name: string): Promise<TagMutationResponse> {
  return api('/api/tags', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function renameTag(id: number, name: string): Promise<TagMutationResponse> {
  return api(`/api/tags/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function deleteTag(id: number): Promise<{ ok: boolean }> {
  return api(`/api/tags/${id}/delete`, { method: 'POST' });
}

/** 拖拽排序落库：按新顺序全量重编号；响应即新列表（乐观更新后对齐权威顺序）。 */
export function reorderTags(ids: number[]): Promise<TagsResponse> {
  return api('/api/tags/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
}

// ---------------------------------------------------------------------------
// 片商字典（logo BLOB 入库，经专用端点存取）
// ---------------------------------------------------------------------------

export function fetchStudios(): Promise<StudiosResponse> {
  return api('/api/studios');
}

export function createStudio(name: string): Promise<StudioMutationResponse> {
  return api('/api/studios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function renameStudio(id: number, name: string): Promise<StudioMutationResponse> {
  return api(`/api/studios/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function deleteStudio(id: number): Promise<{ ok: boolean }> {
  return api(`/api/studios/${id}/delete`, { method: 'POST' });
}

/** 设置/替换 logo：{b64}（文件）或 {url}（服务端抓取）。 */
export function setStudioLogo(id: number, payload: { b64?: string; url?: string }): Promise<StudioMutationResponse> {
  return api(`/api/studios/${id}/logo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function clearStudioLogo(id: number): Promise<{ ok: boolean }> {
  return api(`/api/studios/${id}/logo/delete`, { method: 'POST' });
}

// ---------------------------------------------------------------------------
// 女优（演员体系核心；头像 = 归档的 raw 图片）
// ---------------------------------------------------------------------------

export function fetchActresses(q = ''): Promise<ActressesResponse> {
  return api(`/api/actresses${q ? `?q=${encodeURIComponent(q)}` : ''}`);
}

export function fetchActressDisks(): Promise<ActressDisksResponse> {
  return api('/api/actresses/disks');
}

export function createActress(payload: ActressUpsertRequest): Promise<ActressMutationResponse> {
  return api('/api/actresses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function updateActress(id: number, payload: ActressUpsertRequest): Promise<ActressMutationResponse> {
  return api(`/api/actresses/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function deleteActress(id: number): Promise<{ ok: boolean }> {
  return api(`/api/actresses/${id}/delete`, { method: 'POST' });
}

/** 原始资料页设为头像：图片 raw 行归档移动到女优图集目录并更新引用。 */
export function setActressAvatar(id: number, fileId: number): Promise<ActressMutationResponse> {
  return api(`/api/actresses/${id}/avatar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId }),
  });
}

// ---------------------------------------------------------------------------
// 作品（原始资料页归档流）
// ---------------------------------------------------------------------------

/** 视频归档（单片）：文件移动改名 + videos 及四张关系表落库。 */
export function archiveVideo(payload: VideoArchiveRequest): Promise<VideoMutationResponse> {
  return api('/api/videos/archive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** 作品分页列表（title/subtitle/code 搜索；将来作品页地基）。 */
export function fetchWorks(query: { page?: number; size?: number; q?: string }): Promise<WorksResponse> {
  const p = new URLSearchParams();
  if (query.page) p.set('page', String(query.page));
  if (query.size) p.set('size', String(query.size));
  if (query.q) p.set('q', query.q);
  return api(`/api/works?${p.toString()}`);
}

export interface RawEventsQuery {
  page: number;
  size: number;
  kind?: 'rename' | 'move';
  /** 单文件时间线：全量正序返回。 */
  fileId?: number;
}

export function fetchRawEvents(query: RawEventsQuery): Promise<RawEventsResponse> {
  const p = new URLSearchParams({
    page: String(query.page),
    size: String(query.size),
  });
  if (query.kind) p.set('kind', query.kind);
  if (query.fileId != null) p.set('file_id', String(query.fileId));
  return api(`/api/raw/events?${p.toString()}`);
}

export interface RawArchivedQuery {
  page: number;
  size: number;
  q?: string;
  type?: 'video' | 'image';
  volume?: string;
}

export function fetchRawArchived(query: RawArchivedQuery): Promise<RawArchivedResponse> {
  const p = new URLSearchParams({
    page: String(query.page),
    size: String(query.size),
  });
  if (query.q) p.set('q', query.q);
  if (query.type) p.set('type', query.type);
  if (query.volume) p.set('volume', query.volume);
  return api(`/api/raw/archived?${p.toString()}`);
}
