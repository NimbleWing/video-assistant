import type {
  ConfigResponse,
  DownloadsResponse,
  LogResponse,
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
