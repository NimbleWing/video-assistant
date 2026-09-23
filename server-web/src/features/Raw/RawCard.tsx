import { fmtDate, fmtSize } from '@/utils/format';
import { TrashButton } from '@/components/TrashButton';
import type { RawFileRow } from '@/lib/types';

interface Props {
  it: RawFileRow;
  onPlay: (it: RawFileRow) => void;
  /** 图片卡片点击查看大图。 */
  onView: (it: RawFileRow) => void;
  /** 删除入口：删磁盘文件 + 库记录。 */
  onDelete: (it: RawFileRow) => void;
  /** 「设为头像」入口（图片卡片）：归档移动到女优图集。 */
  onAvatar: (it: RawFileRow) => void;
  /** 「归档」入口（视频卡片）：弹归档表单。 */
  onArchive: (it: RawFileRow) => void;
}

/** 当前名（path 末段去扩展名；archived 行的 path 随文件更新，name 列停留在最初名）。 */
function currentNameOf(p: string): string {
  const seg = p.slice(p.lastIndexOf('/') + 1);
  return seg.replace(/\.[a-z0-9]+$/i, '') || seg;
}

/** 视频头图区：类型图标 + 扩展名大字（不抽帧，留后续增强）+ hover 播放遮罩。 */
function VideoArt({ it, onPlay }: Pick<Props, 'it' | 'onPlay'>) {
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

/** 原始资料卡片（Raw 页独享）：图片=真缩略图（点击查看大图）；视频=图标卡；删除/设头像/归档操作；missing 灰化。 */
export function RawCard({ it, onPlay, onView, onDelete, onAvatar, onArchive }: Props) {
  const gone = it.missing || it.pending_missing;
  const currentName = currentNameOf(it.path);
  return (
    <div
      className={`card overflow-hidden p-0 transition-[border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-brand/60 ${
        gone ? 'opacity-55' : ''
      }`}
    >
      {it.type === 'image' ? (
        <button
          type="button"
          className="block aspect-video w-full cursor-zoom-in overflow-hidden bg-raised"
          aria-label={`查看 ${currentName}`}
          onClick={() => onView(it)}
        >
          <img
            src={`/api/raw/file/${it.id}/content`}
            alt={currentName}
            loading="lazy"
            className="aspect-video w-full object-cover"
          />
        </button>
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
          {it.type === 'image' ? (
            <button
              type="button"
              className="flex size-6 shrink-0 items-center justify-center rounded-md bg-raised text-dim transition-colors hover:bg-brand-soft hover:text-brand-hover disabled:cursor-default disabled:opacity-40"
              aria-label={`设为头像 ${currentNameOf(it.path)}`}
              title="设为女优头像"
              onClick={() => onAvatar(it)}
            >
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="8.2" r="3.4" />
                <path d="M5.5 19.5c.9-3.3 3.5-5 6.5-5s5.6 1.7 6.5 5" />
              </svg>
            </button>
          ) : null}
          {it.type === 'video' ? (
            <button
              type="button"
              className="flex size-6 shrink-0 items-center justify-center rounded-md bg-raised text-dim transition-colors hover:bg-brand-soft hover:text-brand-hover disabled:cursor-default disabled:opacity-40"
              aria-label={`归档 ${currentNameOf(it.path)}`}
              title="归档（移动到女优目录并登记作品）"
              onClick={() => onArchive(it)}
            >
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 5.5h11.5v6H4z" />
                <path d="M15.5 8h2.8l2.7 3v3.5h-5.5" />
                <circle cx="7.5" cy="17.5" r="1.8" />
                <circle cx="17" cy="17.5" r="1.8" />
                <path d="M9.3 17.5h5.9" />
              </svg>
            </button>
          ) : null}
          <TrashButton
            label={`删除文件 ${it.path}`}
            title={`删除 ${it.path}（磁盘文件 + 库记录，不可恢复）`}
            onClick={() => onDelete(it)}
          />
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
