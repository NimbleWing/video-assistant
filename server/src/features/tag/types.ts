// 标签字典领域类型（纯类型文件，server-web 经相对路径 re-export 消费）。

/** tags 表行；计数为预留字段（关联表落地前恒 0）。 */
export interface TagRow {
  id: number;
  name: string;
  sort: number;
  video_count: number;
  actor_count: number;
}

export interface TagsResponse {
  ok: boolean;
  items: TagRow[];
}

export interface TagMutationResponse {
  ok: boolean;
  item: TagRow;
}
