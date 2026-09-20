// 作品领域类型（纯类型文件，server-web 经相对路径 re-export 消费）。

export type VideoKind = 'single' | 'series';

/** 作品条目（列表视角；文件经 video_file_id/cover_file_id → raw_files 取）。 */
export interface VideoRow {
  id: number;
  kind: VideoKind;
  title: string;
  subtitle: string | null;
  code: string | null;
  video_file_id: number;
  cover_file_id: number | null;
  created_at: number;
  actresses: { id: number; name: string }[];
  tags: { id: number; name: string; sort: number }[];
  studios: { id: number; name: string }[];
  countries: { id: number; name: string }[];
}

export interface VideosResponse {
  ok: boolean;
  total: number;
  items: VideoRow[];
}

export interface VideoMutationResponse {
  ok: boolean;
  item: VideoRow;
}

/** POST /api/videos/archive 归档请求（封面自动匹配在前端完成，此处只传 coverFileId）。 */
export interface VideoArchiveRequest {
  fileId: number;
  coverFileId?: number | null;
  title: string;
  subtitle?: string;
  code?: string;
  actressIds: number[];
  countryId: number;
  tagIds: number[];
  studioId?: number | null;
  kind: VideoKind;
}
