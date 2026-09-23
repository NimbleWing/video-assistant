import { useState } from 'react';
import { Clock, Film, User, MapPin, Tag, Hash, Building, Monitor, FileText } from 'lucide-react';
import { fmtDur, fmtSize } from '@/utils/format';
import type { VideoRow } from '@/lib/types';
import { GlowCard } from '@/components/GlowCard';
import { MediaFallback } from '@/components/MediaFallback';
import { RatingRing } from '@/components/RatingRing';
import { ChipSection, MetaLine } from '@/components/MetaSection';

interface Props {
  it: VideoRow;
  onPlay: (it: VideoRow) => void;
  /** 点击封面看大图（PhotoSwipe 查看器，App 层挂载）。 */
  onView: (it: VideoRow) => void;
  /** 评分环修改（加分配额 0 至 100−base_rating；null = 清除）。 */
  onRate: (it: VideoRow, rating: number | null) => void;
}

/** 分辨率分档（对齐 tauri 版卡片）：4K / 1080p / 720p / 原始 WxH。 */
function resolutionOf(width: number, height: number): string {
  if (width >= 3840 && height >= 2160) return '4K';
  if (width >= 1920 && height >= 1080) return '1080p';
  if (width >= 1280 && height >= 720) return '720p';
  return `${width}x${height}`;
}

/**
 * 视频库卡片（Video 页独享）：tauri-react VideoProbeCard 视觉复刻——
 * GlowCard 赛博渐变光晕 + 封面 hover 缩放/毛玻璃放大预览 + 时长/分辨率角标 + 评分渐变圆环（点击改分）
 * + 渐变标题/PERFORMERS/STUDIO/CODE/COUNTRY/TAGS 分区。播放仍走 onPlay（探活 + PlayerDialog）。
 * 结构件（GlowCard/MediaFallback/RatingRing/ChipSection/MetaLine）与 ActressCard 共用。
 */
export function VideoCard({ it, onPlay, onView, onRate }: Props) {
  const [broken, setBroken] = useState(false);
  const vf = it.video_file;
  const dur = vf?.duration ?? null;
  const hasRes = vf?.width != null && vf?.height != null;
  const noCover = it.cover_file_id == null;
  const coverSrc = noCover ? '' : `/api/raw/file/${it.cover_file_id}/content`;
  // 展示分 = min(100, 基础分 + 加分配额)（未加分按 0 计：卡片恒有评分环，清除加分即回到基础分）
  const score = Math.min(100, it.base_rating + (it.rating ?? 0));

  return (
    <GlowCard>
      {/* 封面区：点击看大图；hover 缩放 + 毛玻璃 contain 预览 + 中央播放钮 */}
      <div className="relative aspect-video overflow-hidden">
        {noCover || broken ? (
          <MediaFallback inaccessible={!noCover} icon={Film} emptyText="无封面" brokenText="封面无法访问" />
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
          <RatingRing
            score={score}
            value={it.rating}
            max={100 - it.base_rating}
            name={it.title}
            onRate={(v) => onRate(it, v)}
          />
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
          <ChipSection icon={User} label="PERFORMERS" items={it.actresses} tone="cyan" />
          {it.studios.length > 0 && (
            <MetaLine icon={Building} label="STUDIO" tone="purple" text={it.studios.map((s) => s.name).join(' · ')} />
          )}
          {it.code ? <MetaLine icon={Hash} label="CODE" tone="green" text={it.code} /> : null}
          {it.countries.length > 0 && (
            <MetaLine icon={MapPin} label="COUNTRY" tone="amber" text={it.countries.map((c) => c.name).join(' · ')} />
          )}
        </div>

        <ChipSection icon={Tag} label="TAGS" items={it.tags} tone="pink" divided />

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
    </GlowCard>
  );
}
