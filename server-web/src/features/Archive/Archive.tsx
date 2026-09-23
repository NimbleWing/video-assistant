import { useEffect, useState } from 'react';
import { fetchRawArchived } from '@/lib/api';
import type { PlaySource } from '@/components/PlayerDialog';
import { ArchiveCard } from './ArchiveCard';
import { NATIVE_VIDEO_EXTS } from '@/utils/media';
import type { ViewImage } from '@/components/ImageViewer';
import { Pager } from '@/components/Pager';
import type { ArchivedItem, RawArchivedResponse, RawFileRow, RawType } from '@/lib/types';
import { EventsDialog } from './EventsDialog';

const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_OPTIONS = [20, 50, 100];

interface Props {
  onStat: (text: string) => void;
  onPlay: (src: PlaySource) => void;
  /** 打开图片查看器：gallery=当前列表全部图片，index=定位下标。 */
  onView: (items: ViewImage[], index: number) => void;
}

/** 归档资料页：archived=1 逻辑文件的卡片浏览（发生过移动/改名，单行跟随）。 */
export function Archive({ onStat, onPlay, onView }: Props) {
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [type, setType] = useState<'' | RawType>('');
  const [volume, setVolume] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(DEFAULT_PAGE_SIZE);
  const [data, setData] = useState<RawArchivedResponse | null>(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<RawFileRow | null>(null);

  // 搜索防抖 300ms
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(qInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const statVols = data?.volumes ?? [];
  const effVolume = volume && statVols.some((v) => v.volume === volume) ? volume : '';

  useEffect(() => {
    let alive = true;
    fetchRawArchived({ page, size, q, type: type || undefined, volume: effVolume || undefined })
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError('');
        const videos = d.volumes.reduce((a, v) => a + v.videos, 0);
        const images = d.volumes.reduce((a, v) => a + v.images, 0);
        onStat(`归档 ${d.total} · 视频 ${videos} · 图片 ${images}`);
      })
      .catch((e: unknown) => {
        if (alive) setError(String((e as Error)?.message || e));
      });
    return () => {
      alive = false;
    };
  }, [page, size, q, type, effVolume, onStat]);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / size));

  const play = (it: RawFileRow) => {
    onPlay({
      path: it.path,
      direct: `/api/raw/file/${it.id}/content`,
      hls: `/api/raw/file/${it.id}/index.m3u8`,
      preferDirect: NATIVE_VIDEO_EXTS.has(it.ext),
    });
  };

  /** 查看图片：以当前页全部图片为 gallery（可左右切图），定位到被点条目。 */
  const view = (it: ArchivedItem) => {
    const images = items.filter((x) => x.type === 'image');
    onView(
      images.map((x) => ({ src: `/api/raw/file/${x.id}/content`, alt: x.path })),
      Math.max(0, images.indexOf(it)),
    );
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="mb-4 flex shrink-0 flex-wrap items-center gap-2.5">
        <input
          type="search"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="搜索最初名 / 路径"
          aria-label="搜索归档资料"
        />
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value as '' | RawType);
            setPage(1);
          }}
          aria-label="归档类型"
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
          aria-label="归档盘符"
        >
          <option value="">全部盘符</option>
          {statVols.map((v) => (
            <option key={v.volume} value={v.volume}>
              {v.volume}（{v.files}）
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <div className="shrink-0 rounded-xl border border-dashed border-line py-14 text-center text-dim">加载失败：{error}</div>
      ) : items.length === 0 ? (
        <div className="shrink-0 rounded-xl border border-dashed border-line py-14 text-center text-dim">
          {total === 0 && !q && !type && !effVolume
            ? '暂无归档文件（改名/移动经扫描自动判定后进入归档）'
            : '没有匹配的条目'}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
            {items.map((it) => (
              <ArchiveCard key={it.id} it={it} onPlay={play} onView={view} onHistory={setHistory} />
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
      <EventsDialog item={history} onClose={() => setHistory(null)} />
    </section>
  );
}
