// 国家字典领域类型（纯类型文件，server-web 经相对路径 re-export 消费）。

/** countries 表行。 */
export interface CountryRow {
  id: number;
  name: string;
}

export interface CountriesResponse {
  ok: boolean;
  items: CountryRow[];
}

export interface CountryMutationResponse {
  ok: boolean;
  item: CountryRow;
}
