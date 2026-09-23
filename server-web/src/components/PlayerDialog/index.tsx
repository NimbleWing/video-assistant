import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { VideoPlayer } from '@/components/VideoPlayer';
import type { PlaySource } from '@/components/VideoPlayer';

export type { PlaySource };

interface Props {
  item: PlaySource | null;
  onClose: () => void;
  /** 标题下方补充行（如格式提示），可选。 */
  extra?: ReactNode;
}

/** 播放弹层：路径标题 + 通用播放内核（VideoPlayer）+ 复制路径/关闭。 */
export function PlayerDialog({ item, onClose, extra }: Props) {
  const dlgRef = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const dlg = dlgRef.current;
    if (dlg && item && !dlg.open) dlg.showModal();
  }, [item]);

  async function copy() {
    if (!item) return;
    try {
      await navigator.clipboard.writeText(item.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // 剪贴板不可用时静默（与旧版一致）
    }
  }

  return (
    <dialog ref={dlgRef} onClose={onClose} closedby="any">
      {item && (
        <>
          <div className="mb-3 max-w-[86vw] text-[13px] text-dim [overflow-wrap:anywhere]">{item.path}</div>
          {extra ? <div className="mb-3 max-w-[86vw] text-xs text-dim">{extra}</div> : null}
          <VideoPlayer item={item} width={960} height={540} className="block max-h-[78vh] max-w-[86vw] rounded-lg bg-black" />
          <div className="mt-3 flex justify-end gap-2.5">
            <button type="button" className="act" onClick={() => void copy()}>
              {copied ? '已复制' : '复制路径'}
            </button>
            <button type="button" className="act act-primary" onClick={() => dlgRef.current?.close()}>
              关闭
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
