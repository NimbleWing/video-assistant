import type {
  ConfigResponse,
  DownloadsResponse,
  LogResponse,
  RawArchivedResponse,
  RawEventsResponse,
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
  VideosResponse,
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
