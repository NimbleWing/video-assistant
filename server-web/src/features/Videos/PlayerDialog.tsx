import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';

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

  // item 变化换源：HLS 主路径（服务端 ffmpeg 重整分段，remux 产物直连播会抖）+ 三级降级链
  // （hls.js fatal manifest 错误 → 直连；不支持 MSE → Safari 原生 HLS；再否则直连）。
  // 清理时停流（Esc / 遮罩点击 / 关闭按钮殊途同归）。
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !item) return;
    let hls: Hls | null = null;
    let settled = false; // 已降级直连/原生 HLS，不再重复处理
    const playDirect = () => {
      settled = true;
      v.src = `/stream/${item.id}`;
      v.play().catch(() => {});
    };
    if (Hls.isSupported()) {
      hls = new Hls();
      const self = hls;
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal || settled || hls !== self) return;
        // 清单拉不下来（典型：服务端 ffmpeg 缺失 503）→ 降级直连；
        // 分段偶发错误由 hls.js 自行重试，媒体错误走恢复流程，均不降级。
        const d = data.details;
        if (
          data.type === Hls.ErrorTypes.NETWORK_ERROR &&
          (d === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
            d === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
            d === Hls.ErrorDetails.MANIFEST_PARSING_ERROR ||
            d === Hls.ErrorDetails.LEVEL_LOAD_ERROR ||
            d === Hls.ErrorDetails.LEVEL_LOAD_TIMEOUT)
        ) {
          hls.destroy();
          hls = null;
          playDirect();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          self.recoverMediaError();
        }
      });
      hls.loadSource(`/stream/${item.id}/index.m3u8`);
      hls.attachMedia(v);
      v.play().catch(() => {});
    } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
      settled = true;
      v.src = `/stream/${item.id}/index.m3u8`;
      v.play().catch(() => {});
    } else {
      playDirect();
    }
    return () => {
      hls?.destroy();
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
          <div className="mb-3 max-w-[86vw] text-[13px] text-dim [overflow-wrap:anywhere]">{item.path}</div>
          <video
            ref={videoRef}
            controls
            preload="metadata"
            width={960}
            height={540}
            className="block max-h-[78vh] max-w-[86vw] rounded-lg bg-black"
          />
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
