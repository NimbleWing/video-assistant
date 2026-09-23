import type { LucideIcon } from 'lucide-react';

/**
 * 媒体占位（封面/头像三态的后两态，VideoCard/ActressCard 共用）：
 * 无图 = 中性渐变 + cyan 图标；无法访问 = err 色调，视觉区分。
 */
export function MediaFallback({
  inaccessible,
  icon: Icon,
  emptyText,
  brokenText,
  className = 'aspect-video',
}: {
  inaccessible: boolean;
  icon: LucideIcon;
  emptyText: string;
  brokenText: string;
  /** 媒体区比例，封面 aspect-video / 头像 aspect-square。 */
  className?: string;
}) {
  return (
    <div
      className={`relative flex w-full flex-col items-center justify-center gap-2 overflow-hidden bg-gradient-to-br ${
        inaccessible ? 'from-[#2a1519] via-gray-900 to-black' : 'from-gray-950 via-gray-900 to-black'
      } ${className}`}
    >
      {!inaccessible ? (
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(56,189,248,0.1),transparent_70%)]" />
      ) : null}
      <div className="relative z-10 flex flex-col items-center">
        <Icon className={`h-16 w-16 ${inaccessible ? 'text-err/60' : 'text-cyan-400/60'}`} />
        <span className={`mt-2 text-sm ${inaccessible ? 'text-err/50' : 'text-cyan-400/40'}`}>
          {inaccessible ? brokenText : emptyText}
        </span>
      </div>
    </div>
  );
}
