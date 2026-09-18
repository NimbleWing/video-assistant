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

/** ffmpeg 探测状态（/api/config、/api/ping 聚合；source: config=用户配置路径 / path=PATH 探测 / null=均不可用）。 */
export interface FfmpegStatus {
  available: boolean;
  path: string;
  source: 'config' | 'path' | null;
}

export interface ConfigResponse {
  ok: boolean;
  scanDirs: string[];
  /** 用户配置的 ffmpeg 路径（空串 = 未配置，走 PATH）。 */
  ffmpegPath: string;
  ffmpeg: FfmpegStatus;
}

export interface SaveConfigResponse {
  ok: boolean;
  warnings: string[];
}
