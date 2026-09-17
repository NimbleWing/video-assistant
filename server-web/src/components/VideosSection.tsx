import { useEffect, useState } from 'react';
import { fetchVideos } from '../api';
import { fmtDate, fmtDur, fmtSize } from '../format';
import type { VideoItem, VideosResponse } from '../types';
import { Pager } from './Pager';

const PAGE_SIZE = 50;

interface Props {
  onStat: (text: string) => void;
  onPlay: (item: { id: number; path: string }) => void;
}

/** 封面区（视频条目带 hover 播放遮罩与角标；封面条目纯展示）。 */
function Cover({ it, onPlay }: { it: VideoItem; onPlay: (item: { id: number; path: string }) => void }) {
  const thumbId = it.type === 'cover' ? it.id : it.cover_id;
  return (
    <button
      type="button"
      className="group/cover relative block w-full cursor-pointer overflow-hidden bg-raised text-left"
      aria-label={it.type === 'video' ? `播放 ${it.stem}` : it.stem}
      onClick={() => it.type === 'video' && onPlay({ id: it.id, path: it.path })}
    >
      {thumbId != null ? (
        <img
          src={`/stream/${thumbId}`}
          alt={it.stem}
          loading="lazy"
          className="aspect-video w-full object-cover transition-transform duration-500 group-hover/cover:scale-105"
        />
      ) : (
        <span className="flex aspect-video w-full items-center justify-center bg-gradient-to-br from-art to-[#101216]">
          <svg
            viewBox="0 0 24 24"
            width="34"
            height="34"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
            className="text-art-ink/70"
          >
            <rect x="2.5" y="4.5" width="19" height="15" rx="3" />
            <path d="M7 4.5v15M17 4.5v15M2.5 9h4.5M2.5 15h4.5M17 9h4.5M17 15h4.5" />
          </svg>
        </span>
      )}
      {it.type === 'video' && (
        <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity duration-200 group-hover/cover:opacity-100">
          <span className="flex size-11 items-center justify-center rounded-full bg-brand text-on-brand shadow-lg shadow-black/40 transition-transform duration-200 group-hover/cover:scale-110">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden>
              <path d="M8.5 5.5v13l11-6.5z" />
            </svg>
          </span>
        </span>
      )}
      {/* 角标 */}
      <span className={`badge badge-${it.type} absolute left-2 top-2`}>
        {it.type === 'video' ? it.ext.toUpperCase() : '封面'}
      </span>
      {it.duration ? (
        <span className="absolute right-2 top-2 rounded-md bg-black/65 px-1.5 py-0.5 font-mono text-[11px] text-ink backdrop-blur-sm">
          {fmtDur(it.duration)}
        </span>
      ) : null}
      <span className="absolute bottom-2 left-2 rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] text-ink backdrop-blur-sm">
        {fmtSize(it.size)}
      </span>
      {it.volume ? (
        <span className="absolute bottom-2 right-2 rounded-md bg-black/65 px-1.5 py-0.5 font-mono text-[11px] uppercase text-ink backdrop-blur-sm">
          {it.volume}
        </span>
      ) : null}
    </button>
  );
}

export function VideosSection({ onStat, onPlay }: Props) {
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [volume, setVolume] = useState('');
  const [type, setType] = useState<'video' | 'cover'>('video');
  const [page, setPage] = useState(1);
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
    fetchVideos({ page, size: PAGE_SIZE, q, volume: effVolume || undefined, type })
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
  }, [page, q, effVolume, type, onStat]);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

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
            <div
              key={it.id}
              className="card overflow-hidden p-0 transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-brand/60"
            >
              <Cover it={it} onPlay={onPlay} />
              <div className="p-3.5">
                <div className="line-clamp-2 text-[13px] font-medium leading-snug" title={it.stem}>
                  {it.stem}
                </div>
                <div className="mt-1.5 truncate text-xs text-dim" title={it.path}>
                  {it.path}
                </div>
                <div className="mt-2 text-xs text-dim">{fmtDate(it.mtime)}</div>
              </div>
            </div>
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
      />
    </section>
  );
}
