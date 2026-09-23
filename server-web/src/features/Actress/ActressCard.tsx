import { useState } from 'react';
import { Film, HardDrive, MapPin, Pencil, Tag, Trash2, User } from 'lucide-react';
import type { ActressRow } from '@/lib/types';
import { GlowCard } from '@/components/GlowCard';
import { MediaFallback } from '@/components/MediaFallback';
import { RatingRing } from '@/components/RatingRing';
import { ChipSection, MetaLine } from '@/components/MetaSection';

interface Props {
  it: ActressRow;
  /** 删除进行中（禁用删除钮）。 */
  busy?: boolean;
  onEdit: (it: ActressRow) => void;
  onRemove: (it: ActressRow) => void;
  /** 评分环修改（绝对分 0-100；null = 清除）。 */
  onRate: (it: ActressRow, rating: number | null) => void;
}

/**
 * 女优卡片：与 VideoCard 同源的赛博结构——GlowCard 外发光 + aspect-square 头像区
 * （三态：图 / 无头像 / 头像无法访问；hover 缩放 + 中央编辑/删除圆钮）+ 评分渐变圆环（绝对分，点击改分）
 * + 渐变名字 / 别名副标题 / COUNTRY 分区 / TAGS 区 + 底行视频数 × 磁盘。
 */
export function ActressCard({ it, busy, onEdit, onRemove, onRate }: Props) {
  const [broken, setBroken] = useState(false);
  const noAvatar = it.avatar_file_id == null;
  const avatarSrc = noAvatar ? '' : `/api/raw/file/${it.avatar_file_id}/content`;

  return (
    <GlowCard>
      {/* 头像区：hover 缩放 + 中央编辑/删除圆钮 */}
      <div className="relative aspect-square overflow-hidden">
        {noAvatar || broken ? (
          <MediaFallback
            inaccessible={!noAvatar}
            icon={User}
            emptyText="无头像"
            brokenText="头像无法访问"
            className="aspect-square"
          />
        ) : (
          <img
            src={avatarSrc}
            alt={`${it.name} 头像`}
            loading="lazy"
            onError={() => setBroken(true)}
            className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-105"
          />
        )}

        <div className="absolute inset-0 flex items-center justify-center gap-3 opacity-0 transition-opacity duration-200 hover:opacity-100 focus-within:opacity-100">
          <span className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <button
            type="button"
            aria-label={`编辑 ${it.name}`}
            title="编辑（名字/国家/评分/标签/别名）"
            onClick={() => onEdit(it)}
            className="relative flex size-11 items-center justify-center rounded-full bg-brand text-on-brand shadow-lg shadow-black/40 transition-transform duration-200 hover:scale-110"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={`删除 ${it.name}`}
            title="删除女优"
            disabled={busy}
            onClick={() => onRemove(it)}
            className="relative flex size-11 items-center justify-center rounded-full bg-red-600 text-white shadow-lg shadow-black/40 transition-transform duration-200 hover:scale-110 disabled:cursor-default disabled:opacity-40"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>

        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-cyan-500/5 to-transparent opacity-0 transition-opacity duration-1000 group-hover:opacity-100" />
      </div>

      <div className="p-4">
        <div className="mb-2 flex items-start gap-3">
          <RatingRing score={it.rating} value={it.rating} max={100} name={it.name} onRate={(v) => onRate(it, v)} />
          <h3
            className="flex-1 cursor-pointer bg-gradient-to-r from-cyan-400 to-purple-400 bg-clip-text text-base font-bold leading-snug text-transparent line-clamp-2"
            title={`${it.name}（点击编辑）`}
            onClick={() => onEdit(it)}
          >
            {it.name}
          </h3>
        </div>

        {it.aliases.length > 0 ? (
          <p className="mb-3 truncate text-sm font-light italic text-gray-400" title={it.aliases.join('、')}>
            {it.aliases.join(' · ')}
          </p>
        ) : null}

        <div className="space-y-3">
          <MetaLine icon={MapPin} label="COUNTRY" tone="amber" text={it.country_name || '—'} />
        </div>

        <ChipSection icon={Tag} label="TAGS" items={it.tags} tone="pink" divided />

        <div className="mt-5 flex items-center justify-between border-t border-gray-800 pt-3 text-xs text-gray-500">
          <span className="flex items-center gap-1.5">
            <Film className="h-3 w-3" />
            <span className="font-mono">视频 {it.video_count}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <HardDrive className="h-3 w-3" />
            <span className="font-mono">{it.disk || '-'}</span>
          </span>
        </div>
      </div>
    </GlowCard>
  );
}
