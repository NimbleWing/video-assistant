// 作品领域类型（纯类型文件，server-web 经相对路径 re-export 消费）。

export type VideoKind = 'single' | 'series';

/** 作品条目（列表视角；文件经 video_file_id/cover_file_id → raw_files 取）。 */
export interface VideoRow {
  id: number;
  kind: VideoKind;
  title: string;
  subtitle: string | null;
  code: string | null;
  /** 加分配额（0 至 100−base_rating，可空；null = 未加分）。展示分 = min(100, base_rating + rating)。 */
  rating: number | null;
  /** 基础分：关联演员最高评分（演员未评分按 0；无演员为 0）。 */
  base_rating: number;
  video_file_id: number;
  cover_file_id: number | null;
  created_at: number;
  /** 归档视频行（缝合 raw_files：播放源判定 + 封面外的元数据）。正常恒有值（归档链路保证行不可删），null 仅防御库被手工改动等极端情况，前端归入「丢失」态。 */
  video_file: { id: number; path: string; ext: string; size: number; duration: number | null; width: number | null; height: number | null } | null;
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
  /** 加分配额（0 至 100−演员最高评分；null/缺省 = 不加分）。 */
  rating?: number | null;
  actressIds: number[];
  countryId: number;
  tagIds: number[];
  studioId?: number | null;
  kind: VideoKind;
}
