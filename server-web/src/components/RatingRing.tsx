import { useState } from 'react';
import { Star } from 'lucide-react';
import { RatingInput } from '@/components/RatingInput';

/** 评分档位配色（对齐 tauri 版卡片）：76+ 青绿 / 51+ 黄橙 / 其余红粉。 */
function ratingColor(rating: number): { from: string; via: string; to: string; glow: string } {
  if (rating >= 76)
    return { from: 'from-emerald-500', via: 'via-cyan-500', to: 'to-teal-500', glow: 'shadow-emerald-500/50' };
  if (rating >= 51)
    return { from: 'from-yellow-500', via: 'via-orange-500', to: 'to-amber-500', glow: 'shadow-yellow-500/50' };
  return { from: 'from-red-500', via: 'via-rose-500', to: 'to-pink-500', glow: 'shadow-red-500/50' };
}

/**
 * 评分渐变圆环（VideoCard/ActressCard 共用）：有分 = 按档位配色的渐变圆环；
 * 未评分 = hover 浮现的虚线环。点击开 RatingInput 改分弹层。
 * score = 展示分；value/max 透传 RatingInput（女优绝对分 max=100；作品加分配额 max=100−基础分）。
 */
export function RatingRing({
  score,
  value,
  max = 100,
  nullText = '未评分',
  name,
  onRate,
}: {
  score: number | null;
  value: number | null;
  max?: number;
  /** RatingInput 空值文案（作品加分制传「未加分」）。 */
  nullText?: string;
  /** aria/title 文案用的对象名（标题/女优名）。 */
  name: string;
  onRate: (v: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-label={score == null ? `为 ${name} 评分` : `评分 ${score}，点击修改`}
        title={score == null ? '未评分，点击评分' : `评分 ${score}`}
        onClick={() => setEditing((v) => !v)}
        className={
          score != null
            ? `relative flex h-12 w-12 items-center justify-center rounded-full bg-gradient-to-br ${ratingColor(score).from} ${ratingColor(score).via} ${ratingColor(score).to} shadow-lg ${ratingColor(score).glow} transition-transform duration-200 hover:scale-110`
            : 'flex h-12 w-12 items-center justify-center rounded-full border border-dashed border-gray-700 text-gray-600 opacity-0 transition-all duration-200 hover:border-cyan-500/50 hover:text-cyan-400 group-hover:opacity-100'
        }
      >
        {score != null ? (
          <>
            <span className="absolute inset-0 rounded-full bg-gradient-to-br from-white/20 to-transparent" />
            <span className="relative font-mono text-sm font-bold text-white">{score}</span>
          </>
        ) : (
          <Star className="h-5 w-5" />
        )}
      </button>
      {editing ? (
        <div className="absolute left-0 top-14 z-20 w-64 rounded-xl border border-gray-700 bg-gray-900 p-3 shadow-2xl shadow-black/60">
          <RatingInput
            value={value}
            max={max}
            nullText={nullText}
            onChange={(v) => {
              onRate(v);
              if (v == null) setEditing(false);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
