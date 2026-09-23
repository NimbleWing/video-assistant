import { useEffect, useRef } from 'react';
import Hls from 'hls.js';

/** 播放源：direct=Range 直连；hls=转码清单；preferDirect=直连优先（原生格式省转码，error 回退 hls）。 */
export interface PlaySource {
  path: string;
  direct: string;
  hls?: string;
  preferDirect?: boolean;
}

interface Props {
  item: PlaySource;
  className?: string;
  width?: number;
  height?: number;
}

/**
 * 通用视频播放内核：默认 hls.js 主路径（服务端 ffmpeg 转码，remux 产物直连播会抖）+ 三级降级链；
 * preferDirect 时反转——直连优先，<video> error（编解码不支持）回退 hls。换源/卸载时停流。
 */
export function VideoPlayer({ item, className, width, height }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    let hls: Hls | null = null;
    let settled = false; // 已降级直连/原生 HLS，不再重复处理
    const playDirect = () => {
      settled = true;
      v.src = item.direct;
      v.play().catch(() => {});
    };
    const startHls = () => {
      if (settled) return;
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
        hls.loadSource(item.hls as string);
        hls.attachMedia(v);
        v.play().catch(() => {});
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        settled = true;
        v.src = item.hls as string;
        v.play().catch(() => {});
      } else {
        playDirect();
      }
    };

    let onDirectError: (() => void) | null = null;
    if (item.preferDirect && item.hls) {
      // 原生格式直连优先；error（如带 HEVC 的 mkv 编解码不支持）→ 升级 hls 转码
      settled = true;
      v.src = item.direct;
      v.play().catch(() => {});
      onDirectError = () => {
        v.removeEventListener('error', onDirectError as () => void);
        settled = false;
        startHls();
      };
      v.addEventListener('error', onDirectError);
    } else if (item.hls) {
      startHls();
    } else {
      playDirect();
    }

    return () => {
      if (onDirectError) v.removeEventListener('error', onDirectError);
      hls?.destroy();
      v.pause();
      v.removeAttribute('src');
      v.load();
    };
  }, [item]);

  return <video ref={videoRef} controls preload="metadata" width={width} height={height} className={className} />;
}
