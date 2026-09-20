// 片商字典领域类型（纯类型文件，server-web 经相对路径 re-export 消费）。

/** studios 表行（列表视角；logo 字节经 /api/studios/:id/logo 专用端点取）。 */
export interface StudioRow {
  id: number;
  name: string;
  has_logo: boolean;
  video_count: number;
  actor_count: number;
}

export interface StudiosResponse {
  ok: boolean;
  items: StudioRow[];
}

export interface StudioMutationResponse {
  ok: boolean;
  item: StudioRow;
}
