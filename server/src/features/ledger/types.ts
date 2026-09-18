// 下载账本领域类型（纯类型文件，server-web 经相对路径 re-export 消费）。

export type DlStatus = 'downloading' | 'complete' | 'failed' | 'canceled' | 'skipped';

/** downloads 表行（一行一视频，upsert by (site, video_id)）。 */
export interface DownloadRow {
  id: number;
  site: string;
  video_id: string;
  page_path: string;
  name: string;
  series_name: string | null;
  quality: number | null;
  filename: string;
  status: DlStatus;
  error: string | null;
  attempts: number;
  size: number | null;
  created_at: number;
  updated_at: number;
}

export type DownloadItem = DownloadRow;

export interface DownloadsResponse {
  ok: boolean;
  total: number;
  items: DownloadRow[];
  counts: Record<string, number>;
}

/** POST /api/downloads 登记请求。 */
export interface DownloadUpsertRequest {
  site?: string;
  videoId: string;
  pagePath?: string;
  name?: string;
  seriesName?: string | null;
  quality?: number;
  filename?: string;
  status: DlStatus;
  error?: string | null;
  size?: number;
}
