import { useState } from 'react';
import { fmtDur } from '@/utils/format';
import type { VideoRow } from '@/lib/types';

interface Props {
  it: VideoRow;
  onPlay: (it: VideoRow) => void;
}

/** 头图占位（封面三态的后两态）：无封面 = 中性；无法访问 = err 色调，视觉区分。 */
function CoverFallback({ inaccessible }: { inaccessible: boolean }) {
  return (
    <span
      className={`flex aspect-video w-full flex-col items-center justify-center gap-2 bg-gradient-to-br ${
        inaccessible ? 'from-[#2a1519] to-[#101216] text-err' : 'from-art to-[#101216] text-art-ink/70'
      }`}
    >
      <svg
        viewBox="0 0 24 24"
        width="30"
        height="30"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        className="opacity-80"
      >
        {inaccessible ? (
          <>
            <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
            <circle cx="9" cy="10" r="1.4" />
            <path d="M4.5 17.5 14 9.5l5.5 5" />
            <path d="M3 3l18 18" />
          </>
        ) : (
          <>
            <rect x="2.5" y="4.5" width="19" height="15" rx="3" />
            <path d="M7 4.5v15M17 4.5v15M2.5 9h4.5M2.5 15h4.5M17 9h4.5M17 15h4.5" />
          </>
        )}
      </svg>
      <span className="text-xs">{inaccessible ? '封面无法访问' : '无封面'}</span>
    </span>
  );
}

/** 视频库卡片：封面三态 + 番号/时长 badge + 标题/副标题/演员/标签/国家·片商。 */
export function WorkCard({ it, onPlay }: Props) {
  const [broken, setBroken] = useState(false);
  const dur = it.video_file?.duration ?? null;
  const noCover = it.cover_file_id == null;
  const meta = [...it.countries.map((c) => c.name), ...it.studios.map((s) => s.name)].join(' · ');
  const tagNames = it.tags.map((t) => t.name);

  return (
    <div className="card overflow-hidden p-0 transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-brand/60">
      <button
        type="button"
        className="group/art relative block w-full cursor-pointer overflow-hidden bg-raised text-left"
        aria-label={`播放 ${it.title}`}
        onClick={() => onPlay(it)}
      >
        {noCover || broken ? (
          <CoverFallback inaccessible={!noCover} />
        ) : (
          <span className="block aspect-video w-full overflow-hidden bg-raised">
            <img
              src={`/api/raw/file/${it.cover_file_id}/content`}
              alt={it.title}
              loading="lazy"
              className="aspect-video w-full object-cover"
              onError={() => setBroken(true)}
            />
          </span>
        )}
        {it.code ? (
          <span className="badge absolute left-2 top-2 bg-black/65 font-mono text-ink backdrop-blur-sm" title={`番号 ${it.code}`}>
            {it.code}
          </span>
        ) : null}
        {dur ? (
          <span className="absolute bottom-2 right-2 rounded-md bg-black/65 px-1.5 py-0.5 font-mono text-[11px] text-ink backdrop-blur-sm">
            {fmtDur(dur)}
          </span>
        ) : null}
        <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity duration-200 group-hover/art:opacity-100">
          <span className="flex size-11 items-center justify-center rounded-full bg-brand text-on-brand shadow-lg shadow-black/40 transition-transform duration-200 group-hover/art:scale-110">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden>
              <path d="M8.5 5.5v13l11-6.5z" />
            </svg>
          </span>
        </span>
      </button>
      <div className="p-3.5">
        <div className="line-clamp-2 text-[13px] font-medium leading-snug" title={it.title}>
          {it.title}
        </div>
        {it.subtitle ? (
          <div className="mt-1 truncate text-xs text-dim" title={it.subtitle}>
            {it.subtitle}
          </div>
        ) : null}
        {it.actresses.length ? (
          <div className="mt-1.5 truncate text-xs text-dim" title={it.actresses.map((a) => a.name).join(' · ')}>
            {it.actresses.map((a) => a.name).join(' · ')}
          </div>
        ) : null}
        {tagNames.length ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {it.tags.slice(0, 3).map((t) => (
              <span key={t.id} className="chip" title={tagNames.join(' · ')}>
                {t.name}
              </span>
            ))}
            {tagNames.length > 3 ? (
              <span className="chip" title={tagNames.join(' · ')}>
                +{tagNames.length - 3}
              </span>
            ) : null}
          </div>
        ) : null}
        {meta ? <div className="mt-2 truncate text-xs text-dim">{meta}</div> : null}
      </div>
    </div>
  );
}
