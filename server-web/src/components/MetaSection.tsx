import type { LucideIcon } from 'lucide-react';

/** chips 分区配色：cyan = 人物（PERFORMERS）；pink = 标签（TAGS）。 */
const chipTones = {
  cyan: 'border-cyan-700/30 bg-gradient-to-r from-cyan-900/30 to-purple-900/30 text-cyan-300 hover:border-cyan-600/50',
  pink: 'border-pink-700/20 bg-gradient-to-r from-pink-900/20 to-rose-900/20 text-pink-300 hover:border-pink-600/40',
} as const;

export type ChipTone = keyof typeof chipTones;

/**
 * chips 分区（VideoCard/ActressCard 共用）：图标 + 等宽大写标签头 + 渐变 chips 全量展示。
 * divided = 上方分隔线（TAGS 区惯例）。
 */
export function ChipSection({
  icon: Icon,
  label,
  items,
  tone,
  divided = false,
}: {
  icon: LucideIcon;
  label: string;
  items: { id: number | string; name: string }[];
  tone: ChipTone;
  divided?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className={divided ? 'mt-4 border-t border-gray-800 pt-4' : undefined}>
      <div className="mb-1.5 flex items-center gap-2">
        <Icon className={`h-3.5 w-3.5 ${tone === 'cyan' ? 'text-cyan-400' : 'text-pink-400'}`} />
        <span className="font-mono text-xs uppercase tracking-wider text-gray-400">{label}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((t) => (
          <span
            key={t.id}
            className={`rounded-md border px-2 py-1 font-mono text-xs transition-colors duration-200 ${chipTones[tone]}`}
          >
            {t.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 行内分区配色：purple = STUDIO / green = CODE / amber = COUNTRY。 */
const lineTones = {
  purple: 'text-purple-400',
  green: 'text-green-400',
  amber: 'text-amber-400',
} as const;

export type LineTone = keyof typeof lineTones;

/** 行内分区（VideoCard/ActressCard 共用）：图标 + 彩色等宽大写标签 + 同行文本。 */
export function MetaLine({
  icon: Icon,
  label,
  tone,
  text,
}: {
  icon: LucideIcon;
  label: string;
  tone: LineTone;
  text: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${lineTones[tone]}`} />
      <div className="text-xs">
        <span className={`font-mono uppercase tracking-wider ${lineTones[tone]}`}>{label}</span>
        <span className="ml-1 text-gray-300">{text}</span>
      </div>
    </div>
  );
}
