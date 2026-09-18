import { useEffect, useState } from 'react';

interface PagerProps {
  page: number;
  pages: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  /** 跳页回调；提供后显示页码输入框（回车/失焦提交，钳位 1..pages） */
  onJump?: (page: number) => void;
  /** 每页条数；与 onSizeChange 同时提供时显示「每页 N 条」选择器 */
  size?: number;
  sizeOptions?: readonly number[];
  onSizeChange?: (size: number) => void;
}

export function Pager({ page, pages, total, onPrev, onNext, onJump, size, sizeOptions, onSizeChange }: PagerProps) {
  const [draft, setDraft] = useState(String(page));
  useEffect(() => setDraft(String(page)), [page]);

  const commit = () => {
    const n = Number.parseInt(draft, 10);
    setDraft(String(page)); // 无论合法与否先复位，非法输入（空/0）直接忽略
    if (Number.isFinite(n) && n !== page) onJump?.(Math.min(pages, Math.max(1, n)));
  };

  return (
    <div className="mt-4 flex shrink-0 flex-wrap items-center gap-2.5 pb-1 text-[13px] text-dim">
      <button type="button" className="act" disabled={page <= 1} onClick={onPrev}>
        上一页
      </button>
      {onJump ? (
        <span className="flex items-center gap-1.5">
          <input
            type="text"
            inputMode="numeric"
            aria-label="跳转页码"
            value={draft}
            onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
            }}
            onBlur={commit}
            className="w-14 rounded-md border border-transparent bg-raised px-2 py-1 text-center text-[13px] text-ink outline-none focus-visible:border-brand"
          />
          / {pages} 页（共 {total}）
        </span>
      ) : (
        <span>
          {page} / {pages}（共 {total}）
        </span>
      )}
      <button type="button" className="act" disabled={page >= pages} onClick={onNext}>
        下一页
      </button>
      {size != null && onSizeChange ? (
        <label className="ml-auto flex items-center gap-1.5">
          每页
          <select
            aria-label="每页条数"
            value={size}
            onChange={(e) => onSizeChange(Number(e.target.value))}
          >
            {(sizeOptions ?? [20, 50, 100]).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          条
        </label>
      ) : null}
    </div>
  );
}
