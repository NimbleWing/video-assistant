interface PagerProps {
  page: number;
  pages: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

export function Pager({ page, pages, total, onPrev, onNext }: PagerProps) {
  return (
    <div className="mt-3 flex items-center gap-2 text-dim">
      <button type="button" className="act" disabled={page <= 1} onClick={onPrev}>
        上一页
      </button>
      <span>
        {page} / {pages}（共 {total}）
      </span>
      <button type="button" className="act" disabled={page >= pages} onClick={onNext}>
        下一页
      </button>
    </div>
  );
}
