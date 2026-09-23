/** 评分行：slider 0-100 + 未评分清除（女优/作品评分共用约定）。 */
export function RatingInput({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={value ?? 0}
        aria-label="评分"
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1"
      />
      <span className="w-16 shrink-0 text-right font-mono text-xs text-dim">
        {value == null ? '未评分' : `${value} / 100`}
      </span>
      <button
        type="button"
        className="act shrink-0"
        onClick={() => onChange(null)}
        disabled={value == null}
        title="清除评分"
      >
        清除
      </button>
    </div>
  );
}
