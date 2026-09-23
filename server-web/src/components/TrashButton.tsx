/** 删除图标按钮（卡片行/查重文件行等共用）。 */
export function TrashButton({ label, title, disabled, onClick }: { label: string; title: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="flex size-6 shrink-0 items-center justify-center rounded-md bg-raised text-dim transition-colors hover:bg-err-soft hover:text-err disabled:cursor-default disabled:opacity-40"
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M4 7h16M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12M10 11v6M14 11v6" />
      </svg>
    </button>
  );
}
