// 女优领域类型（纯类型文件，server-web 经相对路径 re-export 消费）。

/** 女优条目上的标签摘要（列表渲染与多选回显用）。 */
export interface ActressTag {
  id: number;
  name: string;
  sort: number;
}

/** 女优条目（列表视角；头像经 avatar_file_id → /api/raw/file/:id/content 取）。 */
export interface ActressRow {
  id: number;
  name: string;
  country_id: number;
  country_name: string;
  /** 0-100 百分制；null = 未评分。 */
  rating: number | null;
  /** 创建时选定的盘符（'d:'，此后不可改）。 */
  disk: string;
  avatar_file_id: number | null;
  aliases: string[];
  tags: ActressTag[];
  /** 预留：video_actresses 落地后计算。 */
  video_count: number;
}

export interface ActressesResponse {
  ok: boolean;
  items: ActressRow[];
}

export interface ActressMutationResponse {
  ok: boolean;
  item: ActressRow;
}

export interface ActressDisksResponse {
  ok: boolean;
  disks: string[];
}

/** 创建/编辑女优请求体（编辑时 disk 忽略）。 */
export interface ActressUpsertRequest {
  name: string;
  countryId: number;
  rating: number | null;
  tagIds: number[];
  aliases: string[];
  disk?: string;
}
