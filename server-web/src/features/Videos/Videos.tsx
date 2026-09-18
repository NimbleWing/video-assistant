import { useEffect, useState } from 'react';
import { fetchVideos } from '@/lib/api';
import type { VideosResponse } from '@/lib/types';
import { Pager } from '@/components/Pager';
import { VideoCard } from './VideoCard';

const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_OPTIONS = [20, 50, 100];

interface Props {
  onStat: (text: string) => void;
  onPlay: (item: { id: number; path: string }) => void;
}

export function Videos({ onStat, onPlay }: Props) {
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [volume, setVolume] = useState('');
  const [type, setType] = useState<'video' | 'cover'>('video');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(DEFAULT_PAGE_SIZE);
  const [data, setData] = useState<VideosResponse | null>(null);
  const [error, setError] = useState('');

  // 搜索防抖 300ms
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(qInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

  const volumes = data?.volumes ?? [];
  // 当前选中盘符已从库中消失时回退「全部」（自愈，不改状态避免循环刷新）
  const effVolume = volume && volumes.some((v) => v.volume === volume) ? volume : '';

  useEffect(() => {
    let alive = true;
    fetchVideos({ page, size, q, volume: effVolume || undefined, type })
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError('');
        const totalVideos = d.volumes.reduce((a, v) => a + v.videos, 0);
        onStat(`视频 ${totalVideos} · 命中 ${d.total}`);
      })
      .catch((e: unknown) => {
        if (alive) setError(String((e as Error)?.message || e));
      });
    return () => {
      alive = false;
    };
  }, [page, size, q, effVolume, type, onStat]);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / size));

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="mb-4 flex shrink-0 flex-wrap items-center gap-2.5">
        <input
          type="search"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="搜索文件名 / 路径"
          aria-label="搜索"
        />
        <select
          value={effVolume}
          onChange={(e) => {
            setVolume(e.target.value);
            setPage(1);
          }}
          aria-label="盘符"
        >
          <option value="">全部盘符</option>
          {volumes.map((v) => (
            <option key={v.volume} value={v.volume}>
              {v.volume}（{v.videos}）
            </option>
          ))}
        </select>
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value as 'video' | 'cover');
            setPage(1);
          }}
          aria-label="类型"
        >
          <option value="video">视频</option>
          <option value="cover">封面</option>
        </select>
      </div>
      {error ? (
        <div className="shrink-0 rounded-xl border border-dashed border-line py-14 text-center text-dim">加载失败：{error}</div>
      ) : items.length === 0 ? (
        <div className="shrink-0 rounded-xl border border-dashed border-line py-14 text-center text-dim">
          没有匹配的条目（先在设置页配置目录并扫描）
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
          {items.map((it) => (
            <VideoCard key={it.id} it={it} onPlay={onPlay} />
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
