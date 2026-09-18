import { useEffect, useRef, useState } from 'react';
import { fetchRawEvents } from '@/lib/api';
import type { RawEventItem, RawFileRow } from '@/lib/types';

interface Props {
  item: RawFileRow | null;
  onClose: () => void;
}

function currentNameOf(p: string): string {
  const seg = p.slice(p.lastIndexOf('/') + 1);
  return seg.replace(/\.[a-z0-9]+$/i, '') || seg;
}

/** 单文件变更记录弹窗：当前名 + 最初名 + 事件时间线（fetchRawEvents({ fileId })，时间正序）。 */
export function EventsDialog({ item, onClose }: Props) {
  const dlgRef = useRef<HTMLDialogElement>(null);
  const [events, setEvents] = useState<RawEventItem[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const dlg = dlgRef.current;
    if (dlg && item && !dlg.open) dlg.showModal();
  }, [item]);

  useEffect(() => {
    if (!item) return;
    let alive = true;
    setEvents(null);
    setError('');
    fetchRawEvents({ page: 1, size: 500, fileId: item.id })
      .then((d) => {
        if (alive) setEvents(d.items);
      })
      .catch((e: unknown) => {
        if (alive) setError(String((e as Error)?.message || e));
      });
    return () => {
      alive = false;
    };
  }, [item]);

  return (
    <dialog ref={dlgRef} onClose={onClose} closedby="any">
      {item && (
        <>
          <div className="mb-1 text-[15px] font-bold">{currentNameOf(item.path)}</div>
          <div className="mb-3 text-[13px] text-dim">
            最初名：{item.name}
            <span className="mx-1.5">·</span>
            <span className="font-mono text-xs [overflow-wrap:anywhere]">{item.path}</span>
          </div>
          {error ? (
            <div className="py-8 text-center text-sm text-err">加载失败：{error}</div>
          ) : events == null ? (
            <div className="py-8 text-center text-sm text-dim">加载中…</div>
          ) : events.length === 0 ? (
            <div className="py-8 text-center text-sm text-dim">暂无变更记录</div>
          ) : (
            <ol className="m-0 flex max-h-[60vh] w-[560px] max-w-[86vw] list-none flex-col gap-2.5 overflow-y-auto p-0">
              {events.map((ev) => (
                <li key={ev.id} className="rounded-lg bg-raised/50 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className={`badge ${ev.kind === 'move' ? 'badge-video' : 'badge-complete'} shrink-0`}>
                      {ev.kind === 'move' ? '移动' : '改名'}
                    </span>
                    <span className="text-[13px] leading-snug [overflow-wrap:anywhere]">{ev.result}</span>
                  </div>
                  <div className="mt-1 text-xs text-dim">
                    {new Date(ev.created_at).toLocaleString('zh-CN', { hour12: false })}
                  </div>
                </li>
              ))}
            </ol>
          )}
          <div className="mt-3 flex justify-end">
            <button type="button" className="act act-primary" onClick={() => dlgRef.current?.close()}>
              关闭
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
