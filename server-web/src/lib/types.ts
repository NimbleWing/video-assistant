// API 模型单一来源：re-export server 侧各 feature 的 types.ts（字段名对齐 server/db 列名）。
// 服务端响应结构变更时此处由编译器抓住，避免两端字段漂移。
export type {
  FileType,
  FileSource,
  FileRow,
  VideoItem,
  VolumeStat,
  VideosResponse,
  ExistsMatch,
  ExistsResponse,
  ScanResult,
  ScanResponse,
  ConfigResponse,
  SaveConfigResponse,
} from '../../../server/src/features/media/types';
export type {
  DlStatus,
  DownloadRow,
  DownloadItem,
  DownloadsResponse,
  DownloadUpsertRequest,
} from '../../../server/src/features/ledger/types';
export type { PingResponse, LogResponse } from '../../../server/src/features/system/types';
