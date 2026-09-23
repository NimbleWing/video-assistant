import type { ReactNode } from 'react';

/**
 * 赛博风卡片外壳（VideoCard/ActressCard 共用）：深灰 gray-900 底 +
 * cyan→purple→pink 双层渐变外发光（hover 浮现：模糊光晕 + 淡色罩）。
 */
export function GlowCard({ children }: { children: ReactNode }) {
  return (
    <div className="group relative mx-auto w-full overflow-visible rounded-2xl bg-gray-900">
      {/* 外发光（hover 浮现，两层：模糊光晕 + 淡色罩） */}
      <div className="absolute -inset-1 -z-10 rounded-2xl bg-gradient-to-r from-cyan-500/20 via-purple-500/20 to-pink-500/20 opacity-0 blur-xl transition-opacity duration-500 group-hover:opacity-100" />
      <div className="absolute -inset-1 -z-10 rounded-2xl bg-gradient-to-r from-cyan-500/10 via-purple-500/10 to-pink-500/10 opacity-0 transition-opacity duration-500 group-hover:opacity-30" />
      <div className="relative overflow-hidden rounded-2xl border border-gray-800 bg-gray-900/80 backdrop-blur-sm">
        {children}
      </div>
    </div>
  );
}
