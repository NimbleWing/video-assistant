import { fmtDate, fmtSize } from '@/utils/format';
import type { RawFileRow } from '@/lib/types';

interface Props {
  it: RawFileRow;
  onPlay: (it: RawFileRow) => void;
  /** 提供「变更记录」入口（归档页用）；原始资料页不传则不渲染。 */
  onHistory?: (it: RawFileRow) => void;
  /** 提供删除入口（原始资料页用）：删磁盘文件 + 库记录；不传则不渲染。 */
  onDelete?: (it: RawFileRow) => void;
}

/** 浏览器可原生解码的视频格式（直连省转码；mkv 靠 Chromium 内置 matroska demuxer，失败回退 HLS）。 */
export const NATIVE_VIDEO_EXTS = new Set(['mp4', 'webm', 'm4v', 'mov', 'mkv']);

/** 删除图标按钮（卡片行/查重文件行共用）。 */
export function TrashButton({ label, title, disabled, onClick }: { label: string; title: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="flex size-6 shrink-0 items-center justify-center rounded-md bg-raised text-dim transition-colors hover:bg-err-soft hover:text-err disabled:cursor-default disabled:opacity-40"
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 7h16M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12M10 11v6M14 11v6" />
      </svg>
    </button>
  );
}

/** 当前名（path 末段去扩展名；archived 行的 path 随文件更新，name 列停留在最初名）。 */
function currentNameOf(p: string): string {
  const seg = p.slice(p.lastIndexOf('/') + 1);
  return seg.replace(/\.[a-z0-9]+$/i, '') || seg;
}

/** 视频头图区：类型图标 + 扩展名大字（不抽帧，留后续增强）+ hover 播放遮罩。 */
function VideoArt({ it, onPlay }: Props) {
  const label = currentNameOf(it.path);
  return (
    <button
      type="button"
      className="group/art relative block w-full cursor-pointer overflow-hidden bg-raised text-left"
      aria-label={`播放 ${label}`}
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

/** 原始资料卡片（Raw/Archive 两页共享）：图片=真缩略图；视频=图标卡；archived 副行最初名；missing 灰化。 */
export function RawCard({ it, onPlay, onHistory, onDelete }: Props) {
  const gone = it.missing || it.pending_missing;
  const currentName = currentNameOf(it.path);
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
            alt={currentName}
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
          <div className="line-clamp-2 text-[13px] font-medium leading-snug" title={currentName}>
            {currentName}
          </div>
        </div>
        {it.archived ? (
          <div className="mt-1 truncate text-xs text-dim" title={it.name}>
            最初：{it.name}
          </div>
        ) : null}
        <div className="mt-1.5 truncate text-xs text-dim" title={it.path}>
          {it.path}
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs text-dim">
          <span>{fmtSize(it.size)}</span>
          <span className="font-mono uppercase">{it.volume}</span>
          <span className="ml-auto">{fmtDate(it.mtime)}</span>
          {onDelete ? (
            <TrashButton
              label={`删除文件 ${it.path}`}
              title={`删除 ${it.path}（磁盘文件 + 库记录，不可恢复）`}
              onClick={() => onDelete(it)}
            />
          ) : null}
        </div>
        {gone ? (
          <div className="mt-2">
            <span className="badge badge-failed">{it.missing ? '已消失' : '待决策'}</span>
          </div>
        ) : null}
        {onHistory ? (
          <div className="mt-2.5">
            <button
              type="button"
              className="text-xs text-brand-hover transition-colors hover:text-brand"
              onClick={() => onHistory(it)}
            >
              变更记录 →
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
