import { useEffect, useRef, useState } from 'react';
import { setActressAvatar } from '@/lib/api';
import type { ActressRow } from '@/lib/types';
import type { RawFileRow } from '@/lib/types';

interface Props {
  /** 待设为头像的图片 raw 行。 */
  file: RawFileRow;
  onClose: () => void;
  onDone: (msg: string) => void;
}

/** 设为头像弹窗：搜索 + 女优列表，点选即确认（归档移动到女优图集目录）。 */
export function AvatarPicker({ file, onClose, onDone }: Props) {
  const [items, setItems] = useState<ActressRow[] | null>(null);
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);
  const [err, setErr] = useState('');
  const dlgRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dlgRef.current;
    if (d && !d.open) d.showModal();
  }, []);

  useEffect(() => {
    let alive = true;
    fetch('/api/actresses')
      .then((r) => r.json())
      .then((j: { items?: ActressRow[] }) => {
        if (alive) setItems(Array.isArray(j.items) ? j.items : []);
      })
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, []);

  const needle = q.trim().toLowerCase();
  const filtered = (items ?? []).filter(
    (it) => !needle || it.name.toLowerCase().includes(needle) || it.aliases.some((a) => a.toLowerCase().includes(needle)),
  );

  const pick = async (it: ActressRow) => {
    if (busyId != null) return;
    setBusyId(it.id);
    setErr('');
    try {
      await setActressAvatar(it.id, file.id);
      onDone(`已设为「${it.name}」的头像`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusyId(null);
    }
  };

  return (
    <dialog ref={dlgRef} onClose={onClose} closedby="any">
      <div className="w-[min(480px,90vw)]">
        <div className="mb-1 text-[15px] font-bold">设为头像</div>
        <div className="mb-2 truncate text-xs text-dim" title={file.path}>
          图片：{file.path}
        </div>
        <input
          className="w-full"
          placeholder="搜索女优（名字或别名）"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        {err ? <p className="mt-2 text-xs text-err">{err}</p> : null}
        <div className="mt-2 max-h-64 overflow-y-auto">
          {items == null ? (
            <p className="py-6 text-center text-xs text-dim">加载中…</p>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-xs text-dim">没有匹配的女优（先到女优页添加）</p>
          ) : (
            filtered.map((it) => (
              <button
                key={it.id}
                type="button"
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-raised disabled:opacity-50"
                disabled={busyId != null}
                onClick={() => pick(it)}
              >
                {it.avatar_file_id ? (
                  <img src={`/api/raw/file/${it.avatar_file_id}/content`} alt="" className="size-8 shrink-0 rounded-full object-cover" />
                ) : (
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-raised text-xs text-dim">
                    {it.name.slice(0, 1)}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{it.name}</span>
                  <span className="block truncate text-xs text-dim">
                    {it.country_name}
                    {it.aliases.length ? ` · ${it.aliases.slice(0, 2).join(' / ')}` : ''}
                  </span>
                </span>
                {busyId === it.id ? <span className="shrink-0 text-xs text-dim">设置中…</span> : null}
              </button>
            ))
          )}
        </div>
        <div className="mt-3 flex justify-end">
          <button type="button" className="act" onClick={() => dlgRef.current?.close()}>
            取消
          </button>
        </div>
      </div>
    </dialog>
  );
}
