import { useCallback, useEffect, useState } from 'react';
import {
  cancelRawScan,
  fetchRawFiles,
  fetchRawMissing,
  fetchRawVolumes,
  resolveRawMissing,
  startRawScan,
} from '@/lib/api';
import type { PlaySource } from '@/components/PlayerDialog';
import { Pager } from '@/components/Pager';
import type { RawFileRow, RawFilesResponse, RawScanStatus, RawType, RawVolumesResponse } from '@/lib/types';
import { fmtSize } from '@/utils/format';
import { NATIVE_VIDEO_EXTS, RawCard } from './RawCard';

const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_OPTIONS = [20, 50, 100];

interface Props {
  onStat: (text: string) => void;
  onPlay: (src: PlaySource) => void;
}

/** 磁盘选择卡：盘符 + 容量条 + 剩余空间，点击切换勾选。 */
function VolumeCard({
  volume,
  total,
  free,
  checked,
  onToggle,
}: {
  volume: string;
  total: number;
  free: number;
  checked: boolean;
  onToggle: () => void;
}) {
  const used = total > 0 ? Math.min(1, (total - free) / total) : 0;
  return (
    <button
      type="button"
      className={`w-[150px] rounded-xl border p-3 text-left transition-colors ${
        checked ? 'border-brand/70 bg-brand-soft' : 'border-line bg-raised hover:border-brand/40'
      }`}
      aria-pressed={checked}
      aria-label={`盘符 ${volume}`}
      onClick={onToggle}
    >
      <div className="flex items-center gap-2">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-dim">
          <ellipse cx="12" cy="5.5" rx="8" ry="2.8" />
          <path d="M4 5.5v13c0 1.55 3.58 2.8 8 2.8s8-1.25 8-2.8v-13" />
          <path d="M4 12c0 1.55 3.58 2.8 8 2.8s8-1.25 8-2.8" />
        </svg>
        <span className="font-mono text-sm font-bold uppercase">{volume}</span>
        {checked ? (
          <span className="ml-auto flex size-4 items-center justify-center rounded-full bg-brand text-on-brand">
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4.5 12.5l5 5 10-11" />
            </svg>
          </span>
        ) : null}
      </div>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-line/60">
        <div className="h-full rounded-full bg-brand/70" style={{ width: `${Math.round(used * 100)}%` }} />
      </div>
      <div className="mt-1.5 text-[11px] text-dim">
        {total > 0 ? `剩 ${fmtSize(free)} / ${fmtSize(total)}` : '容量未知'}
      </div>
    </button>
  );
}

export function Raw({ onStat, onPlay }: Props) {
  // 扫描面板
  const [volumes, setVolumes] = useState<RawVolumesResponse['volumes']>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [wantVideo, setWantVideo] = useState(true);
  const [wantImage, setWantImage] = useState(true);
  const [status, setStatus] = useState<RawScanStatus | null>(null);
  const [scanErr, setScanErr] = useState('');
  // 待决策消失
  const [missingCount, setMissingCount] = useState(0);
  const [missingItems, setMissingItems] = useState<RawFileRow[] | null>(null);
  const [resolving, setResolving] = useState(false);
  // 文件浏览
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [type, setType] = useState<'' | RawType>('');
  const [volume, setVolume] = useState('');
  const [missingView, setMissingView] = useState<'hide' | 'only' | 'all'>('hide');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(DEFAULT_PAGE_SIZE);
  const [data, setData] = useState<RawFilesResponse | null>(null);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  const refreshMissing = useCallback(() => {
    fetchRawMissing()
      .then((m) => setMissingCount(m.items.length))
      .catch(() => {});
  }, []);

  // 初始化：盘符列表 + 上次勾选恢复 + 待决策数
  useEffect(() => {
    fetchRawVolumes()
      .then((d) => {
        setVolumes(d.volumes);
        const avail = new Set(d.volumes.map((v) => v.volume));
        if (d.lastSelection) {
          setSel(new Set(d.lastSelection.volumes.filter((v) => avail.has(v))));
          if (d.lastSelection.types.length) {
            setWantVideo(d.lastSelection.types.includes('video'));
            setWantImage(d.lastSelection.types.includes('image'));
          }
        }
      })
      .catch((e: unknown) => setScanErr(String((e as Error)?.message || e)));
    refreshMissing();
  }, [refreshMissing]);

  // 搜索防抖 300ms
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(qInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const statVols = data?.volumes ?? [];
  // 当前选中盘符已从库中消失时回退「全部」
  const effVolume = volume && statVols.some((v) => v.volume === volume) ? volume : '';

  useEffect(() => {
    let alive = true;
    fetchRawFiles({ page, size, q, type: type || undefined, volume: effVolume || undefined, missing: missingView })
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError('');
        const videos = d.volumes.reduce((a, v) => a + v.videos, 0);
        const images = d.volumes.reduce((a, v) => a + v.images, 0);
        onStat(`资料 ${videos + images} · 视频 ${videos} · 图片 ${images}`);
      })
      .catch((e: unknown) => {
        if (alive) setError(String((e as Error)?.message || e));
      });
    return () => {
      alive = false;
    };
  }, [page, size, q, type, effVolume, missingView, refreshKey, onStat]);

  // SSE 进度推送：snapshot/progress → 状态；done → 刷新列表与待决策数
  useEffect(() => {
    const es = new EventSource('/api/raw/scan/events');
    const parse = (ev: Event) => JSON.parse((ev as MessageEvent<string>).data) as RawScanStatus;
    es.addEventListener('snapshot', (ev) => setStatus(parse(ev)));
    es.addEventListener('progress', (ev) => setStatus(parse(ev)));
    es.addEventListener('done', (ev) => {
      setStatus(parse(ev));
      setRefreshKey((k) => k + 1);
      refreshMissing();
    });
    return () => es.close();
  }, [refreshMissing]);

  const running = status?.running === true;

  function toggleSel(v: string) {
    setSel((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }

  async function beginScan() {
    const types: RawType[] = [];
    if (wantVideo) types.push('video');
    if (wantImage) types.push('image');
    if (!sel.size || !types.length) return;
    setScanErr('');
    try {
      await startRawScan([...sel], types);
    } catch (e) {
      setScanErr(String((e as Error)?.message || e));
    }
  }

  async function resolve(op: 'delete' | 'mark') {
    setResolving(true);
    try {
      await resolveRawMissing(op);
      setMissingItems(null);
      refreshMissing();
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setScanErr(String((e as Error)?.message || e));
    } finally {
      setResolving(false);
    }
  }

  function toggleMissingList() {
    if (missingItems) {
      setMissingItems(null);
      return;
    }
    fetchRawMissing()
      .then((m) => {
        setMissingItems(m.items);
        setMissingCount(m.items.length);
      })
      .catch((e: unknown) => setScanErr(String((e as Error)?.message || e)));
  }

  const play = (it: RawFileRow) => {
    onPlay({
      path: it.path,
      direct: `/api/raw/file/${it.id}/content`,
      hls: `/api/raw/file/${it.id}/index.m3u8`,
      preferDirect: NATIVE_VIDEO_EXTS.has(it.ext),
    });
  };

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / size));
  const last = status && !status.running ? status.lastResult : null;

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      {/* 扫描面板 */}
      <div className="card mb-4 shrink-0 p-5">
        <div className="mb-3 text-[13px] font-semibold">磁盘（仅列出根目录下有 RawFiles 文件夹的盘）</div>
        {volumes.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-dim">
            未发现包含 RawFiles 目录的磁盘（在各盘根目录创建 RawFiles 文件夹后刷新）
          </div>
        ) : (
          <div className="flex flex-wrap gap-2.5">
            {volumes.map((v) => (
              <VolumeCard
                key={v.volume}
                volume={v.volume}
                total={v.total}
                free={v.free}
                checked={sel.has(v.volume)}
                onToggle={() => toggleSel(v.volume)}
              />
            ))}
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="text-[13px] text-dim">类型</span>
          <button type="button" className="chip" aria-pressed={wantVideo} onClick={() => setWantVideo((v) => !v)}>
            视频
          </button>
          <button type="button" className="chip" aria-pressed={wantImage} onClick={() => setWantImage((v) => !v)}>
            图片
          </button>
          {running ? (
            <div className="ml-auto flex items-center gap-3">
              <span className="text-[13px] text-dim">
                正在扫描 <b className="font-mono uppercase text-ink">{status?.currentVolume}</b> · 已处理{' '}
                {status?.scanned ?? 0}（视频 {status?.videos ?? 0} · 图片 {status?.images ?? 0}）
              </span>
              <button type="button" className="act" onClick={() => void cancelRawScan().catch(() => {})}>
                取消扫描
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="act act-primary ml-auto"
              disabled={!sel.size || (!wantVideo && !wantImage)}
              onClick={() => void beginScan()}
            >
              开始扫描{sel.size ? `（${sel.size} 个盘）` : ''}
            </button>
          )}
        </div>
        {running ? (
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-line/60">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-brand" />
          </div>
        ) : last ? (
          <div className="mt-3 text-xs text-dim" title={last.warnings.join('\n')}>
            上次扫描：新增 {last.newCount} · 更新 {last.updatedCount} · 待决策消失 {last.missingCount} · 用时{' '}
            {Math.max(1, Math.round(last.ms / 1000))}s{last.canceled ? ' · 已取消（未判定消失）' : ''}
            {last.warnings.length ? ` · 警告 ${last.warnings.length} 条` : ''}
          </div>
        ) : null}
        {scanErr ? <div className="mt-3 text-xs text-err">{scanErr}</div> : null}
      </div>

      {/* 待决策消失横幅 */}
      {missingCount > 0 ? (
        <div className="mb-4 shrink-0 rounded-xl border border-warn/40 bg-warn-soft px-4 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-[13px] text-warn">发现 {missingCount} 个文件已消失，待决策</span>
            <button type="button" className="act" onClick={toggleMissingList}>
              {missingItems ? '收起清单' : '查看清单'}
            </button>
            <button type="button" className="act ml-auto" disabled={resolving} onClick={() => void resolve('mark')}>
              全部标记为已消失
            </button>
            <button type="button" className="act" disabled={resolving} onClick={() => void resolve('delete')}>
              全部删除记录
            </button>
          </div>
          {missingItems ? (
            <div className="mt-3 max-h-52 overflow-y-auto rounded-lg bg-black/20 p-2 font-mono text-xs leading-relaxed text-dim">
              {missingItems.map((m) => (
                <div key={m.id} className="truncate" title={`${m.path}（${fmtSize(m.size)}）`}>
                  {m.path}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 文件浏览 */}
      <div className="mb-4 flex shrink-0 flex-wrap items-center gap-2.5">
        <input
          type="search"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="搜索名称 / 路径"
          aria-label="搜索原始资料"
        />
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value as '' | RawType);
            setPage(1);
          }}
          aria-label="原始资料类型"
        >
          <option value="">全部类型</option>
          <option value="video">视频</option>
          <option value="image">图片</option>
        </select>
        <select
          value={effVolume}
          onChange={(e) => {
            setVolume(e.target.value);
            setPage(1);
          }}
          aria-label="原始资料盘符"
        >
          <option value="">全部盘符</option>
          {statVols.map((v) => (
            <option key={v.volume} value={v.volume}>
              {v.volume}（{v.files}）
            </option>
          ))}
        </select>
        <select
          value={missingView}
          onChange={(e) => {
            setMissingView(e.target.value as 'hide' | 'only' | 'all');
            setPage(1);
          }}
          aria-label="消失状态"
        >
          <option value="hide">隐藏已消失</option>
          <option value="only">仅已消失</option>
          <option value="all">全部</option>
        </select>
      </div>
      {error ? (
        <div className="shrink-0 rounded-xl border border-dashed border-line py-14 text-center text-dim">加载失败：{error}</div>
      ) : items.length === 0 ? (
        <div className="shrink-0 rounded-xl border border-dashed border-line py-14 text-center text-dim">
          {total === 0 && !q && !type && !effVolume && missingView === 'hide'
            ? '还没有原始资料（选择盘符开始扫描）'
            : '没有匹配的条目'}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
            {items.map((it) => (
              <RawCard key={it.id} it={it} onPlay={play} />
            ))}
          </div>
        </div>
      )}
      <Pager
        page={page}
        pages={pages}
        total={total}
        onPrev={() => setPage((p) => p - 1)}
        onNext={() => setPage((p) => p + 1)}
        onJump={setPage}
        size={size}
        sizeOptions={PAGE_SIZE_OPTIONS}
        onSizeChange={(n) => {
          setSize(n);
          setPage(1);
        }}
      />
    </section>
  );
}
