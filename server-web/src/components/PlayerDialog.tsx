import { useEffect, useRef, useState } from 'react';

interface Props {
  item: { id: number; path: string } | null;
  onClose: () => void;
}

export function PlayerDialog({ item, onClose }: Props) {
  const dlgRef = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const dlg = dlgRef.current;
    if (dlg && item && !dlg.open) dlg.showModal();
  }, [item]);

  // item 变化换源；清理时停流（Esc / 遮罩点击 / 关闭按钮殊途同归）
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !item) return;
    v.src = `/stream/${item.id}`;
    v.play().catch(() => {});
    return () => {
      v.pause();
      v.removeAttribute('src');
      v.load();
    };
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
          <div className="mb-2 max-w-[86vw] text-[13px] text-dim [overflow-wrap:anywhere]">{item.path}</div>
          <video
            ref={videoRef}
            controls
            preload="metadata"
            width={960}
            height={540}
            className="block max-h-[78vh] max-w-[86vw] bg-black"
          />
          <div className="mt-2.5 flex justify-end gap-2">
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
