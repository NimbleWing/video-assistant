/** 评分行：slider 0-max + 空值文案 + 清除按钮（女优绝对分 max=100；作品加分配额 max=100−基础分、空值文案「未加分」）。 */
export function RatingInput({
  value,
  onChange,
  max = 100,
  nullText = '未评分',
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  max?: number;
  nullText?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={value ?? 0}
        aria-label="评分"
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1"
      />
      <span className="w-16 shrink-0 text-right font-mono text-xs text-dim">
        {value == null ? nullText : `${value} / ${max}`}
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
