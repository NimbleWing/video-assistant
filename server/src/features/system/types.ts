// 服务级领域类型（纯类型文件）。
import type { FfmpegStatus } from '../media/types.ts';

export interface PingResponse {
  ok: boolean;
  uptime: number;
  videos: number;
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
