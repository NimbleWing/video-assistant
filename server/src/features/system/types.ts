// 服务级领域类型（纯类型文件）。

export interface PingResponse {
  ok: boolean;
  uptime: number;
  videos: number;
  covers: number;
  downloads: Record<string, number>;
}

export interface LogResponse {
  ok: boolean;
  lines: number;
  tail: string;
}
