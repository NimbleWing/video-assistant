// 媒体库领域类型（纯类型文件，server-web 经相对路径 re-export 消费）。

export type FileType = 'video' | 'cover';
export type FileSource = 'scanned' | 'recorded';

/** files 表行（磁盘实况，去重判定唯一依据）。 */
export interface FileRow {
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
  source: FileSource;
  first_seen: number;
  last_seen: number;
}

/** /api/videos 条目：FileRow + 封面关联 id。 */
export type VideoItem = FileRow & { cover_id: number | null };

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

export interface ExistsMatch {
  path: string;
  type: FileType;
  size: number;
}

export interface ExistsResponse {
  ok: boolean;
  exists: boolean;
  matches: ExistsMatch[];
}

/** POST /api/files 登记请求。 */
export interface FileRecordRequest {
  absPath: string;
  size?: number;
  videoId?: string;
  duration?: number;
}

export interface ScanResult {
  videos: number;
  covers: number;
  removed: number;
  warnings: string[];
  ms: number;
}

export interface ScanResponse {
  ok: boolean;
  result: ScanResult;
}

export interface ConfigResponse {
  ok: boolean;
  scanDirs: string[];
}

export interface SaveConfigResponse {
  ok: boolean;
  warnings: string[];
}
