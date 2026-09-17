export type FileType = 'video' | 'cover';

export interface VideoItem {
  id: number;
  path: string;
  stem: string;
  ext: string;
  type: FileType;
  size: number;
  mtime: number;
  volume: string;
  video_id: string | null;
  duration: number | null;
  /** 关联封面 files.id（服务端 stem 同名优先、目录名回退；无则 null） */
  cover_id: number | null;
  source: string;
  first_seen: number;
  last_seen: number;
}

export interface VolumeStat {
  volume: string;
  videos: number;
}

export interface VideosResponse {
  ok: boolean;
  total: number;
  items: VideoItem[];
  volumes: VolumeStat[];
}

export interface DownloadItem {
  id: number;
  site: string;
  video_id: string;
  page_path: string;
  name: string;
  series_name: string | null;
  quality: number | null;
  filename: string;
  status: string;
  error: string | null;
  attempts: number;
  size: number | null;
  created_at: number;
  updated_at: number;
}

export interface DownloadsResponse {
  ok: boolean;
  total: number;
  items: DownloadItem[];
  counts: Record<string, number>;
}

export interface ScanResult {
  videos: number;
  covers: number;
  removed: number;
  ms: number;
  warnings?: string[];
}

export interface ConfigResponse {
  ok: boolean;
  scanDirs: string[];
}

export interface SaveConfigResponse {
  ok: boolean;
  warnings: string[];
}

export interface ScanResponse {
  ok: boolean;
  result: ScanResult;
}

export interface LogResponse {
  ok: boolean;
  lines: number;
  tail: string;
}
