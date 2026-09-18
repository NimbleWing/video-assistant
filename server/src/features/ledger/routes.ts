// 下载账本 API 路由：/api/downloads GET（查询，含计数）/ POST（登记 upsert）。
import { asRecord, HttpError, json, readJson, type Route } from '../../lib/http.ts';
import { listDownloads, upsertDownload } from './downloads.ts';
import type { DownloadUpsertRequest, DownloadsResponse, DlStatus } from './types.ts';

const DL_STATUSES = new Set(['downloading', 'complete', 'failed', 'canceled', 'skipped']);

const listRoute: Route['handler'] = ({ res, url }) => {
  const r = listDownloads({
    status: url.searchParams.get('status') ?? undefined,
    site: url.searchParams.get('site') ?? undefined,
    q: url.searchParams.get('q') ?? undefined,
    page: Number(url.searchParams.get('page')) || 1,
    size: Number(url.searchParams.get('size')) || 50,
  });
  const body: DownloadsResponse = { ok: true, ...r };
  json(res, 200, body);
};

const upsertRoute: Route['handler'] = async ({ req, res }) => {
  const body = asRecord(await readJson(req));
  const status = String(body?.status ?? '');
  if (!body?.videoId || !DL_STATUSES.has(status)) throw new HttpError(400, '缺少 videoId 或 status 非法');
  const d: DownloadUpsertRequest = {
    site: body.site != null ? String(body.site) : undefined,
    videoId: String(body.videoId),
    pagePath: body.pagePath != null ? String(body.pagePath) : undefined,
    name: body.name != null ? String(body.name) : undefined,
    seriesName: body.seriesName != null ? String(body.seriesName) : undefined,
    quality: body.quality != null ? Number(body.quality) || undefined : undefined,
    filename: body.filename != null ? String(body.filename) : undefined,
    status: status as DlStatus,
    error: body.error != null ? String(body.error).slice(0, 300) : undefined,
    size: body.size != null ? Number(body.size) || undefined : undefined,
  };
  upsertDownload(d);
  json(res, 200, { ok: true });
};

export const ledgerRoutes: Route[] = [
  { method: 'GET', path: '/api/downloads', handler: listRoute },
  { method: 'POST', path: '/api/downloads', handler: upsertRoute },
];
