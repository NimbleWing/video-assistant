// 服务级领域类型（纯类型文件，server-web 经相对路径 re-export 消费）。
// /api/exists 与 /api/config 于 2026-09-23 随 media feature 退役移入本 feature（见 DESIGN.md §1）。

/** ffmpeg 探测状态（/api/config、/api/ping 聚合；source: config=用户配置路径 / path=PATH 探测 / null=均不可用）。 */
export interface FfmpegStatus {
  available: boolean;
  path: string;
  source: 'config' | 'path' | null;
}

export interface PingResponse {
  ok: boolean;
  uptime: number;
  /** raw_files 现存视频数（missing=0 且 pending_missing=0）。 */
  videos: number;
  /** raw_files 现存图片数。 */
  covers: number;
  downloads: Record<string, number>;
  /** ffmpeg 可用性（HLS 流播放依赖；探测结果服务端缓存）。 */
  ffmpeg: FfmpegStatus;
}

export interface LogResponse {
  ok: boolean;
  lines: number;
  tail: string;
}

export interface ExistsMatch {
  path: string;
  type: 'video' | 'cover';
  size: number;
}

export interface ExistsResponse {
  ok: boolean;
  exists: boolean;
  matches: ExistsMatch[];
}

export interface ConfigResponse {
  ok: boolean;
  /** 用户配置的 ffmpeg 路径（空串 = 未配置，走 PATH）。 */
  ffmpegPath: string;
  ffmpeg: FfmpegStatus;
}

export interface SaveConfigResponse {
  ok: boolean;
  warnings: string[];
}
