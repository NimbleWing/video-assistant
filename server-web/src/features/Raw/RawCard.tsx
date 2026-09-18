import { fmtDate, fmtSize } from '@/utils/format';
import type { RawFileRow } from '@/lib/types';

interface Props {
  it: RawFileRow;
  onPlay: (it: RawFileRow) => void;
}

/** 浏览器可原生解码的视频格式（直连省转码；mkv 靠 Chromium 内置 matroska demuxer，失败回退 HLS）。 */
export const NATIVE_VIDEO_EXTS = new Set(['mp4', 'webm', 'm4v', 'mov', 'mkv']);

/** 视频头图区：类型图标 + 扩展名大字（不抽帧，留后续增强）+ hover 播放遮罩。 */
function VideoArt({ it, onPlay }: Props) {
  return (
    <button
      type="button"
      className="group/art relative block w-full cursor-pointer overflow-hidden bg-raised text-left"
      aria-label={`播放 ${it.name}`}
      onClick={() => onPlay(it)}
    >
      <span className="flex aspect-video w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-art to-[#101216]">
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
        <span className="font-mono text-sm uppercase tracking-widest text-art-ink/70">{it.ext}</span>
      </span>
      <span className="absolute inset-0 flex items-center justify-center bg-black/40 opacity-0 transition-opacity duration-200 group-hover/art:opacity-100">
        <span className="flex size-11 items-center justify-center rounded-full bg-brand text-on-brand shadow-lg shadow-black/40 transition-transform duration-200 group-hover/art:scale-110">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden>
            <path d="M8.5 5.5v13l11-6.5z" />
          </svg>
        </span>
      </span>
    </button>
  );
}

/** 原始资料卡片：图片=真缩略图（content 端点直出）；视频=图标卡；missing 灰化 + 角标。 */
export function RawCard({ it, onPlay }: Props) {
  const gone = it.missing || it.pending_missing;
  return (
    <div
      className={`card overflow-hidden p-0 transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-brand/60 ${
        gone ? 'opacity-55' : ''
      }`}
    >
      {it.type === 'image' ? (
        <span className="block aspect-video w-full overflow-hidden bg-raised">
          <img
            src={`/api/raw/file/${it.id}/content`}
            alt={it.name}
            loading="lazy"
            className="aspect-video w-full object-cover"
          />
        </span>
      ) : (
        <VideoArt it={it} onPlay={onPlay} />
      )}
      <div className="p-3.5">
        <div className="flex items-start gap-2">
          <span className={`badge ${it.type === 'video' ? 'badge-video' : 'badge-cover'} shrink-0`}>
            {it.type === 'video' ? it.ext.toUpperCase() : '图片'}
          </span>
          <div className="line-clamp-2 text-[13px] font-medium leading-snug" title={it.name}>
            {it.name}
          </div>
        </div>
        <div className="mt-1.5 truncate text-xs text-dim" title={it.path}>
          {it.path}
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs text-dim">
          <span>{fmtSize(it.size)}</span>
          <span className="font-mono uppercase">{it.volume}</span>
          <span className="ml-auto">{fmtDate(it.mtime)}</span>
        </div>
        {gone ? (
          <div className="mt-2">
            <span className="badge badge-failed">{it.missing ? '已消失' : '待决策'}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
