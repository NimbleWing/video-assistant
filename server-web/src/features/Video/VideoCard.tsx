import { useState } from 'react';
import { Clock, Film, User, MapPin, Tag, Hash, Building, Monitor, FileText, Star } from 'lucide-react';
import { fmtDur, fmtSize } from '@/utils/format';
import type { VideoRow } from '@/lib/types';
import { RatingInput } from '@/components/RatingInput';

interface Props {
  it: VideoRow;
  onPlay: (it: VideoRow) => void;
  /** 点击封面看大图（PhotoSwipe 查看器，App 层挂载）。 */
  onView: (it: VideoRow) => void;
  /** 评分环修改（0-100；null = 清除）。 */
  onRate: (it: VideoRow, rating: number | null) => void;
}

/** 分辨率分档（对齐 tauri 版卡片）：4K / 1080p / 720p / 原始 WxH。 */
function resolutionOf(width: number, height: number): string {
  if (width >= 3840 && height >= 2160) return '4K';
  if (width >= 1920 && height >= 1080) return '1080p';
  if (width >= 1280 && height >= 720) return '720p';
  return `${width}x${height}`;
}

/** 评分档位配色（对齐 tauri 版卡片）：76+ 青绿 / 51+ 黄橙 / 其余红粉。 */
function ratingColor(rating: number): { from: string; via: string; to: string; glow: string } {
  if (rating >= 76)
    return { from: 'from-emerald-500', via: 'via-cyan-500', to: 'to-teal-500', glow: 'shadow-emerald-500/50' };
  if (rating >= 51)
    return { from: 'from-yellow-500', via: 'via-orange-500', to: 'to-amber-500', glow: 'shadow-yellow-500/50' };
  return { from: 'from-red-500', via: 'via-rose-500', to: 'to-pink-500', glow: 'shadow-red-500/50' };
}

/** 头图占位（封面三态的后两态）：无封面 = 中性；无法访问 = err 色调，视觉区分。 */
function CoverFallback({ inaccessible }: { inaccessible: boolean }) {
  return (
    <div
      className={`relative flex aspect-video w-full flex-col items-center justify-center gap-2 overflow-hidden bg-gradient-to-br ${
        inaccessible ? 'from-[#2a1519] via-gray-900 to-black' : 'from-gray-950 via-gray-900 to-black'
      }`}
    >
      {!inaccessible ? (
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(56,189,248,0.1),transparent_70%)]" />
      ) : null}
      <div className="relative z-10 flex flex-col items-center">
        <Film className={`h-16 w-16 ${inaccessible ? 'text-err/60' : 'text-cyan-400/60'}`} />
        <span className={`mt-2 text-sm ${inaccessible ? 'text-err/50' : 'text-cyan-400/40'}`}>
          {inaccessible ? '封面无法访问' : '无封面'}
        </span>
      </div>
    </div>
  );
}

/**
 * 视频库卡片（Video 页独享）：tauri-react VideoProbeCard 视觉复刻——
 * 深灰赛博渐变光晕 + 封面 hover 缩放/毛玻璃放大预览 + 时长/分辨率角标 + 评分渐变圆环（点击改分）
 * + 渐变标题/PERFORMERS/STUDIO/CODE/COUNTRY/TAGS 分区。播放仍走 onPlay（探活 + PlayerDialog）。
 */
export function VideoCard({ it, onPlay, onView, onRate }: Props) {
  const [broken, setBroken] = useState(false);
  const [editingRating, setEditingRating] = useState(false);
  const vf = it.video_file;
  const dur = vf?.duration ?? null;
  const hasRes = vf?.width != null && vf?.height != null;
  const noCover = it.cover_file_id == null;
  const coverSrc = noCover ? '' : `/api/raw/file/${it.cover_file_id}/content`;

  return (
    <div className="group relative mx-auto overflow-visible rounded-2xl bg-gray-900">
      {/* 外发光（hover 浮现，两层：模糊光晕 + 淡色罩） */}
      <div className="absolute -inset-1 -z-10 rounded-2xl bg-gradient-to-r from-cyan-500/20 via-purple-500/20 to-pink-500/20 opacity-0 blur-xl transition-opacity duration-500 group-hover:opacity-100" />
      <div className="absolute -inset-1 -z-10 rounded-2xl bg-gradient-to-r from-cyan-500/10 via-purple-500/10 to-pink-500/10 opacity-0 transition-opacity duration-500 group-hover:opacity-30" />

      <div className="relative overflow-hidden rounded-2xl border border-gray-800 bg-gray-900/80 backdrop-blur-sm">
        {/* 封面区：点击看大图；hover 缩放 + 毛玻璃 contain 预览 + 中央播放钮 */}
        <div className="relative aspect-video overflow-hidden">
          {noCover || broken ? (
            <CoverFallback inaccessible={!noCover} />
          ) : (
            <>
              <img
                src={coverSrc}
                alt={it.title}
                loading="lazy"
                onError={() => setBroken(true)}
                onClick={() => onView(it)}
                className="h-full w-full cursor-zoom-in object-cover transition-transform duration-700 group-hover:scale-105"
              />
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-300 group-hover:opacity-100">
                <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
                <div className="relative max-h-[90%] max-w-[90%] overflow-hidden rounded-xl border border-white/10 shadow-2xl shadow-black/60">
                  <img src={coverSrc} alt="" aria-hidden className="max-h-full max-w-full object-contain" />
                </div>
              </div>
            </>
          )}

          {dur ? (
            <span className="absolute right-3 top-3 flex items-center gap-1 rounded-lg border border-cyan-500/30 bg-gray-900/80 px-2.5 py-1.5 font-mono text-sm text-cyan-400 backdrop-blur-sm">
              <Clock className="h-3 w-3" />
              {fmtDur(dur)}
            </span>
          ) : null}
          {hasRes ? (
            <span className="absolute bottom-3 left-3 flex items-center gap-1 rounded-lg border border-purple-500/30 bg-gray-900/80 px-2.5 py-1.5 font-mono text-sm text-purple-400 backdrop-blur-sm">
              <Monitor className="h-3 w-3" />
              {resolutionOf(vf!.width!, vf!.height!)}
            </span>
          ) : null}

          {/* 中央播放钮（复用现有探活播放链路） */}
          <button
            type="button"
            aria-label={`播放 ${it.title}`}
            onClick={() => onPlay(it)}
            className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 hover:opacity-100 focus-visible:opacity-100"
          >
            <span className="flex size-11 items-center justify-center rounded-full bg-brand text-on-brand shadow-lg shadow-black/40 transition-transform duration-200 hover:scale-110">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden>
                <path d="M8.5 5.5v13l11-6.5z" />
              </svg>
            </span>
          </button>

          <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-cyan-500/5 to-transparent opacity-0 transition-opacity duration-1000 group-hover:opacity-100" />
        </div>

        <div className="p-4">
          <div className="mb-2 flex items-start gap-3">
            {/* 评分环：有分 = 渐变圆环；未评分 = hover 浮现的虚线环。点击开改分弹层 */}
            <div className="relative shrink-0">
              <button
                type="button"
                aria-label={it.rating == null ? `为 ${it.title} 评分` : `评分 ${it.rating}，点击修改`}
                title={it.rating == null ? '未评分，点击评分' : `评分 ${it.rating}`}
                onClick={() => setEditingRating((v) => !v)}
                className={
                  it.rating != null
                    ? `relative flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br ${ratingColor(it.rating).from} ${ratingColor(it.rating).via} ${ratingColor(it.rating).to} shadow-lg ${ratingColor(it.rating).glow} transition-transform duration-200 hover:scale-110`
                    : 'flex h-12 w-12 items-center justify-center rounded-full border border-dashed border-gray-700 text-gray-600 opacity-0 transition-all duration-200 hover:border-cyan-500/50 hover:text-cyan-400 group-hover:opacity-100'
                }
              >
                {it.rating != null ? (
                  <>
                    <span className="absolute inset-0 rounded-full bg-gradient-to-br from-white/20 to-transparent" />
                    <span className="relative font-mono text-sm font-bold text-white">{it.rating}</span>
                  </>
                ) : (
                  <Star className="h-5 w-5" />
                )}
              </button>
              {editingRating ? (
                <div className="absolute left-0 top-14 z-20 w-64 rounded-xl border border-gray-700 bg-gray-900 p-3 shadow-2xl shadow-black/60">
                  <RatingInput
                    value={it.rating}
                    onChange={(v) => {
                      onRate(it, v);
                      if (v == null) setEditingRating(false);
                    }}
                  />
                </div>
              ) : null}
            </div>
            <h3 className="flex-1 bg-gradient-to-r from-cyan-400 to-purple-400 bg-clip-text text-base font-bold leading-snug text-transparent line-clamp-2" title={it.title}>
              {it.title}
            </h3>
          </div>

          {it.subtitle ? <p className="mb-3 text-sm font-light italic text-gray-400">{it.subtitle}</p> : null}

          {vf ? (
            <div className="mb-3 flex items-center gap-2">
              <FileText className="h-4 w-4 shrink-0 text-blue-400" />
              <span className="text-sm text-gray-300">
                <span className="font-medium text-blue-300">Size:</span> {fmtSize(vf.size)}
              </span>
            </div>
          ) : null}

          <div className="space-y-3">
            {it.actresses.length > 0 && (
              <div>
                <div className="mb-1.5 flex items-center gap-2">
                  <User className="h-3.5 w-3.5 text-cyan-400" />
                  <span className="font-mono text-xs uppercase tracking-wider text-gray-400">PERFORMERS</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {it.actresses.map((a) => (
                    <span
                      key={a.id}
                      className="rounded-md border border-cyan-700/30 bg-gradient-to-r from-cyan-900/30 to-purple-900/30 px-2 py-1 font-mono text-xs text-cyan-300 transition-colors duration-200 hover:border-cyan-600/50"
                    >
                      {a.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {it.studios.length > 0 && (
              <div className="flex items-start gap-2">
                <Building className="mt-0.5 h-3.5 w-3.5 shrink-0 text-purple-400" />
                <div className="text-xs">
                  <span className="font-mono uppercase tracking-wider text-purple-400">STUDIO</span>
                  <span className="ml-1 text-gray-300">{it.studios.map((s) => s.name).join(' · ')}</span>
                </div>
              </div>
            )}

            {it.code ? (
              <div className="flex items-start gap-2">
                <Hash className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-400" />
                <div className="text-xs">
                  <span className="font-mono uppercase tracking-wider text-green-400">CODE</span>
                  <span className="ml-1 text-gray-300">{it.code}</span>
                </div>
              </div>
            ) : null}

            {it.countries.length > 0 && (
              <div className="flex items-start gap-2">
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                <div className="text-xs">
                  <span className="font-mono uppercase tracking-wider text-amber-400">COUNTRY</span>
                  <span className="ml-1 text-gray-300">{it.countries.map((c) => c.name).join(' · ')}</span>
                </div>
              </div>
            )}
          </div>

          {it.tags.length > 0 && (
            <div className="mt-4 border-t border-gray-800 pt-4">
              <div className="mb-2 flex items-center gap-2">
                <Tag className="h-3.5 w-3.5 text-pink-400" />
                <span className="font-mono text-xs uppercase tracking-wider text-gray-400">TAGS</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {it.tags.map((t) => (
                  <span
                    key={t.id}
                    className="rounded-md border border-pink-700/20 bg-gradient-to-r from-pink-900/20 to-rose-900/20 px-2 py-1 font-mono text-xs text-pink-300 transition-colors duration-200 hover:border-pink-600/40"
                  >
                    {t.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {hasRes || dur ? (
            <div className="mt-5 flex items-center justify-between border-t border-gray-800 pt-3 text-xs text-gray-500">
              <span className="flex items-center gap-1.5">
                <Monitor className="h-3 w-3" />
                <span className="font-mono">{hasRes ? `${vf!.width}×${vf!.height}` : '-'}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <Clock className="h-3 w-3" />
                <span className="font-mono">{dur ? fmtDur(dur) : '-'}</span>
              </span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
