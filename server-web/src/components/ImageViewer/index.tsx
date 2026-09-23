import { useEffect, useRef } from 'react';
import PhotoSwipe from 'photoswipe';
import 'photoswipe/style.css';

/** 查看条目：仅需源地址；尺寸未知，打开时懒测量。 */
export interface ViewImage {
  src: string;
  alt?: string;
}

interface Props {
  /** 非 null 时打开查看器。 */
  items: ViewImage[] | null;
  /** 初始定位（items 下标）。 */
  index: number;
  onClose: () => void;
}

/**
 * 通用图片查看器（PhotoSwipe 封装）：滚轮缩放、拖拽平移、双击两级缩放、左右切图、Esc/下滑关闭。
 * 服务端图片尺寸未知——拦截 contentLoad 自测 naturalWidth/Height，回填后重建缩放参数再放行加载。
 */
export function ImageViewer({ items, index, onClose }: Props) {
  // onClose 经 ref 取最新，避免父组件内联回调变化导致查看器重启
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!items?.length) return;
    const pswp = new PhotoSwipe({
      dataSource: items.map((it) => ({ src: it.src, alt: it.alt })),
      index,
      wheelToZoom: true,
      bgOpacity: 0.92,
    });
    let destroyed = false;

    pswp.on('contentLoad', (e) => {
      const { content, isLazy } = e;
      if (content.type !== 'image' || content.data.width || !content.data.src) return;
      e.preventDefault();
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        content.data.width = w;
        content.data.height = h;
        content.width = w;
        content.height = h;
        const slide = content.slide;
        if (slide) {
          slide.width = w;
          slide.height = h;
          slide.calculateSize();
          // 核心在 setContent 时已按 0×0 完成初始定位（pan 停在左上角），
          // 重设 currZoomLevel 与 pan 才能让图片回到视口居中（对齐核心 Slide.resize() 的初始分支）
          slide.zoomAndPanToInitial();
          slide.applyCurrentZoomPan();
        }
        content.load(isLazy, true);
      };
      img.onerror = () => content.onError();
      img.src = content.data.src;
    });
    // 尺寸未知时 appendHeavy 先于内容就绪被消耗（heavyAppended=true 而 element 尚未创建），
    // activate 时不再补挂载——loadComplete 时显式 append（幂等），否则切到的幻灯片空白
    pswp.on('loadComplete', ({ content }) => content.append());
    pswp.on('close', () => onCloseRef.current());
    pswp.on('destroy', () => {
      destroyed = true;
    });
    pswp.init();

    return () => {
      if (!destroyed) pswp.destroy();
    };
  }, [items, index]);

  return null;
}
