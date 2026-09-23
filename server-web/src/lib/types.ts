// API 模型单一来源：re-export server 侧各 feature 的 types.ts（字段名对齐 server 列名）。
// 服务端响应结构变更时此处由编译器抓住，避免两端字段漂移。
// （media feature 已退役，其类型随 /api/videos、/api/scan、POST /api/files 一并移除。）
export type {
  PingResponse,
  LogResponse,
  LanResponse,
  ExistsMatch,
  ExistsResponse,
  ConfigResponse,
  SaveConfigResponse,
  FfmpegStatus,
} from '../../../server/src/features/system/types';
export type {
  RawType,
  RawFileRow,
  RawVolume,
  RawVolumesResponse,
  RawVolumeStat,
  RawFilesResponse,
  RawScanResult,
  RawScanStatus,
  RawScanStatusResponse,
  RawScanStartResponse,
  RawScanCancelResponse,
  RawMissingResponse,
  RawResolveOp,
  RawResolveResponse,
  RawDupGroup,
  RawDuplicatesResponse,
  RawFileDeleteResponse,
  RawEventItem,
  RawEventsResponse,
  ArchivedItem,
  RawArchivedResponse,
} from '../../../server/src/features/raw/types';
export type {
  DlStatus,
  DownloadRow,
  DownloadItem,
  DownloadsResponse,
  DownloadUpsertRequest,
} from '../../../server/src/features/ledger/types';
export type { CountryRow, CountriesResponse, CountryMutationResponse } from '../../../server/src/features/country/types';
export type { TagRow, TagsResponse, TagMutationResponse } from '../../../server/src/features/tag/types';
export type { StudioRow, StudiosResponse, StudioMutationResponse } from '../../../server/src/features/studio/types';
export type {
  ActressRow,
  ActressTag,
  ActressesResponse,
  ActressMutationResponse,
  ActressDisksResponse,
  ActressUpsertRequest,
} from '../../../server/src/features/actress/types';
export type { VideoRow, VideoKind, VideosResponse as WorksResponse, VideoMutationResponse, VideoArchiveRequest } from '../../../server/src/features/video/types';
