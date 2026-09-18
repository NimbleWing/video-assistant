import { fmtDate, fmtDur, fmtSize } from '@/utils/format';
import type { VideoItem } from '@/lib/types';

interface Props {
  it: VideoItem;
  onPlay: (item: { id: number; path: string }) => void;
}

/** 封面区（视频条目带 hover 播放遮罩与角标；封面条目纯展示）。 */
function Cover({ it, onPlay }: Props) {
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

/** 视频卡片：封面区（hover 播放遮罩与缩放 + 时长/大小/盘符角标）+ 信息区。 */
export function VideoCard({ it, onPlay }: Props) {
  return (
    <div className="card overflow-hidden p-0 transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-brand/60">
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
  );
}
