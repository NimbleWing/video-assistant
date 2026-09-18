// 原始资料库 API 路由：/api/raw/*（volumes/scan 启停/状态/SSE/files/missing/file 内容与 HLS）。
import { asRecord, HttpError, json, readJson, type Route } from '../../lib/http.ts';
import { deleteRawPhysical, listArchivedFiles, listRawDuplicates, listRawEvents, listRawFiles, listPendingMissing, resolveMissing, rawVolumeStats, getRawFile } from './files.ts';
import { probeRawVolumes } from './volumes.ts';
import { cancelRawScan, rawLastSelection, rawScanStatus, startRawScan } from './scanner.ts';
import { rawContentHandler } from './stream.ts';
import { rawManifestHandler, rawSegmentHandler } from './hls.ts';
import type {
  RawArchivedResponse,
  RawDuplicatesResponse,
  RawEventsResponse,
  RawFileDeleteResponse,
  RawFilesResponse,
  RawMissingResponse,
  RawResolveOp,
  RawResolveResponse,
  RawScanCancelResponse,
  RawScanStartResponse,
  RawScanStatus,
  RawVolumesResponse,
} from './types.ts';

const volumesRoute: Route['handler'] = async ({ res }) => {
  const body: RawVolumesResponse = { ok: true, volumes: await probeRawVolumes(), lastSelection: rawLastSelection() };
  json(res, 200, body);
};

const startScanRoute: Route['handler'] = async ({ req, res }) => {
  const body = asRecord(await readJson(req));
  startRawScan(body?.volumes, body?.types);
  const r: RawScanStartResponse = { ok: true, started: true };
  json(res, 202, r);
};

const cancelScanRoute: Route['handler'] = async ({ res }) => {
  const r: RawScanCancelResponse = { ok: true, canceled: cancelRawScan() };
  json(res, 200, r);
};

const statusRoute: Route['handler'] = ({ res }) => {
  json(res, 200, { ok: true, ...rawScanStatus() });
};

/**
 * SSE：/api/raw/scan/events。连接即推 snapshot → 运行中 ~500ms 推 progress →
 * running→false 翻沿推 done（含 lastResult.missingCount）。连接保持等下次任务。
 * 实现为轮询内存快照（500ms 读对象零成本），天然节流、无监听器分发竞态。
 */
const eventsRoute: Route['handler'] = ({ req, res }) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  let closed = false;
  const send = (event: string, data: RawScanStatus) => {
    if (!closed && !res.destroyed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  let wasRunning = rawScanStatus().running;
  send('snapshot', rawScanStatus());
  const tick = setInterval(() => {
    if (closed) return;
    const s = rawScanStatus();
    if (s.running) {
      send('progress', s);
      wasRunning = true;
    } else if (wasRunning) {
      send('done', s); // 结沿：带 lastResult 的完整结果
      wasRunning = false;
    }
  }, 500);
  // 心跳注释行：防代理/浏览器空闲断连
  const hb = setInterval(() => {
    if (!closed && !res.destroyed && !res.writableEnded) res.write(': ping\n\n');
  }, 15_000);
  req.on('close', () => {
    closed = true;
    clearInterval(tick);
    clearInterval(hb);
  });
};

const filesRoute: Route['handler'] = ({ res, url }) => {
  const r = listRawFiles({
    page: Number(url.searchParams.get('page')) || 1,
    size: Number(url.searchParams.get('size')) || 50,
    q: url.searchParams.get('q') ?? undefined,
    type: url.searchParams.get('type') ?? undefined,
    volume: url.searchParams.get('volume') ?? undefined,
    missing: url.searchParams.get('missing') ?? undefined,
  });
  const body: RawFilesResponse = { ok: true, ...r, volumes: rawVolumeStats() };
  json(res, 200, body);
};

const missingRoute: Route['handler'] = ({ res }) => {
  const body: RawMissingResponse = { ok: true, items: listPendingMissing() };
  json(res, 200, body);
};

const duplicatesRoute: Route['handler'] = ({ res, url }) => {
  const r = listRawDuplicates({
    page: Number(url.searchParams.get('page')) || 1,
    size: Number(url.searchParams.get('size')) || 20,
  });
  const body: RawDuplicatesResponse = { ok: true, ...r };
  json(res, 200, body);
};

const resolveRoute: Route['handler'] = async ({ req, res }) => {
  const body = asRecord(await readJson(req));
  const op = body?.op;
  if (op !== 'delete' && op !== 'mark') throw new HttpError(400, 'op 应为 delete 或 mark');
  const r: RawResolveResponse = { ok: true, affected: resolveMissing(op as RawResolveOp) };
  json(res, 200, r);
};

/** 查重清理：删磁盘文件 + 删行。护栏：路径必须在所在盘 RawFiles 根内（防库外路径误删）。 */
const deleteFileRoute: Route['handler'] = async ({ res, params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, '非法 id');
  const row = getRawFile(id);
  if (!row) throw new HttpError(404, '记录不存在');
  if (!row.path.startsWith(`${row.volume}/rawfiles/`)) throw new HttpError(400, '路径不在 RawFiles 目录内，拒绝删除');
  const r = await deleteRawPhysical(id);
  if (!r) throw new HttpError(404, '记录不存在');
  const body: RawFileDeleteResponse = { ok: true, fileDeleted: r.fileDeleted, rowDeleted: true };
  json(res, 200, body);
};

const rawEventsRoute: Route['handler'] = ({ res, url }) => {
  const r = listRawEvents({
    page: Number(url.searchParams.get('page')) || 1,
    size: Number(url.searchParams.get('size')) || 50,
    kind: url.searchParams.get('kind') ?? undefined,
    fileId: Number(url.searchParams.get('file_id')) || undefined,
  });
  const body: RawEventsResponse = { ok: true, ...r };
  json(res, 200, body);
};

const archivedRoute: Route['handler'] = ({ res, url }) => {
  const r = listArchivedFiles({
    page: Number(url.searchParams.get('page')) || 1,
    size: Number(url.searchParams.get('size')) || 50,
    q: url.searchParams.get('q') ?? undefined,
    type: url.searchParams.get('type') ?? undefined,
    volume: url.searchParams.get('volume') ?? undefined,
  });
  const body: RawArchivedResponse = { ok: true, ...r, volumes: rawVolumeStats() };
  json(res, 200, body);
};

export const rawRoutes: Route[] = [
  { method: 'GET', path: '/api/raw/volumes', handler: volumesRoute },
  { method: 'POST', path: '/api/raw/scan', handler: startScanRoute },
  { method: 'POST', path: '/api/raw/scan/cancel', handler: cancelScanRoute },
  { method: 'GET', path: '/api/raw/scan/status', handler: statusRoute },
  { method: 'GET', path: '/api/raw/scan/events', handler: eventsRoute },
  { method: 'GET', path: '/api/raw/files', handler: filesRoute },
  { method: 'GET', path: '/api/raw/missing', handler: missingRoute },
  { method: 'GET', path: '/api/raw/duplicates', handler: duplicatesRoute },
  { method: 'POST', path: '/api/raw/missing/resolve', handler: resolveRoute },
  { method: 'GET', path: '/api/raw/events', handler: rawEventsRoute },
  { method: 'GET', path: '/api/raw/archived', handler: archivedRoute },
  { method: 'GET', path: '/api/raw/file/:id/content', handler: rawContentHandler },
  { method: 'HEAD', path: '/api/raw/file/:id/content', handler: rawContentHandler },
  { method: 'POST', path: '/api/raw/file/:id/delete', handler: deleteFileRoute },
  { method: 'GET', path: '/api/raw/file/:id/index.m3u8', handler: rawManifestHandler },
  { method: 'HEAD', path: '/api/raw/file/:id/index.m3u8', handler: rawManifestHandler },
  { method: 'GET', path: '/api/raw/file/:id/seg/:seg', handler: rawSegmentHandler },
  { method: 'HEAD', path: '/api/raw/file/:id/seg/:seg', handler: rawSegmentHandler },
];
