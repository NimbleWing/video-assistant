import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageViewer } from './index';

type Handler = (e: unknown) => void;

interface StubInstance {
  options: Record<string, unknown>;
  handlers: Map<string, Handler[]>;
  init: () => void;
  destroy: () => void;
  destroyed: boolean;
}

const instances: StubInstance[] = [];

vi.mock('photoswipe', () => ({
  default: class PhotoSwipeStub implements StubInstance {
    handlers = new Map<string, Handler[]>();
    init = vi.fn();
    destroyed = false;
    constructor(public options: Record<string, unknown>) {
      instances.push(this);
    }
    on(name: string, cb: Handler) {
      const list = this.handlers.get(name) ?? [];
      list.push(cb);
      this.handlers.set(name, list);
    }
    destroy() {
      this.destroyed = true;
    }
  },
}));

/** Image 桩：src 赋值后异步触发 onload（尺寸固定 4000x3000）。 */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 4000;
  naturalHeight = 3000;
  set src(_v: string) {
    queueMicrotask(() => this.onload?.());
  }
}

function emit(ins: StubInstance, name: string, e: unknown) {
  for (const cb of ins.handlers.get(name) ?? []) cb(e);
}

const ITEMS = [
  { src: '/api/raw/file/8/content', alt: 'a.jpg' },
  { src: '/api/raw/file/9/content', alt: 'b.jpg' },
];

beforeEach(() => {
  instances.length = 0;
  vi.stubGlobal('Image', FakeImage);
});

describe('ImageViewer 图片查看器', () => {
  it('items=null 不建实例；传入 items 后以 gallery + index 初始化并 init', () => {
    const { rerender } = render(<ImageViewer items={null} index={0} onClose={() => {}} />);
    expect(instances.length).toBe(0);
    rerender(<ImageViewer items={ITEMS} index={1} onClose={() => {}} />);
    expect(instances.length).toBe(1);
    const ins = instances[0];
    expect(ins.options.index).toBe(1);
    expect(ins.options.wheelToZoom).toBe(true);
    expect(ins.options.dataSource).toEqual([
      { src: '/api/raw/file/8/content', alt: 'a.jpg' },
      { src: '/api/raw/file/9/content', alt: 'b.jpg' },
    ]);
    expect(ins.init).toHaveBeenCalledOnce();
  });

  it('close 事件 → onClose；卸载时未自毁则 destroy', () => {
    const onClose = vi.fn();
    const { unmount } = render(<ImageViewer items={ITEMS} index={0} onClose={onClose} />);
    const ins = instances[0];
    emit(ins, 'close', {});
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(ins.destroyed).toBe(true);
  });

  it('已自毁（destroy 事件）后卸载不再重复 destroy', () => {
    const { unmount } = render(<ImageViewer items={ITEMS} index={0} onClose={() => {}} />);
    const ins = instances[0];
    emit(ins, 'destroy', {});
    ins.destroyed = true; // 事件先行，真实实现里 pswp 自毁
    unmount();
    expect(ins.destroyed).toBe(true);
  });

  it('尺寸未知图片：拦截 contentLoad 懒测量，回填宽高、重设居中并放行加载；loadComplete 时补挂载', async () => {
    render(<ImageViewer items={ITEMS} index={0} onClose={() => {}} />);
    const ins = instances[0];
    const content = {
      type: 'image',
      data: { src: '/api/raw/file/8/content' } as { src: string; width?: number; height?: number },
      width: 0,
      height: 0,
      slide: {
        width: 0,
        height: 0,
        calculateSize: vi.fn(),
        zoomAndPanToInitial: vi.fn(),
        applyCurrentZoomPan: vi.fn(),
      },
      load: vi.fn(),
      onError: vi.fn(),
      append: vi.fn(),
    };
    const ev = { content, isLazy: false, preventDefault: vi.fn() };
    emit(ins, 'contentLoad', ev);
    expect(ev.preventDefault).toHaveBeenCalledOnce();
    await waitFor(() => expect(content.load).toHaveBeenCalledWith(false, true));
    expect(content.data.width).toBe(4000);
    expect(content.data.height).toBe(3000);
    expect(content.slide.calculateSize).toHaveBeenCalledOnce();
    expect(content.slide.zoomAndPanToInitial).toHaveBeenCalledOnce();
    expect(content.slide.applyCurrentZoomPan).toHaveBeenCalledOnce();
    // 补挂载：核心 appendHeavy 已被提前消耗，切图幻灯片依赖此路径挂载元素
    emit(ins, 'loadComplete', { content });
    expect(content.append).toHaveBeenCalledOnce();
  });

  it('已有尺寸或非图片内容不拦截', () => {
    render(<ImageViewer items={ITEMS} index={0} onClose={() => {}} />);
    const ins = instances[0];
    const evSized = {
      content: { type: 'image', data: { src: '/x', width: 800 }, load: vi.fn(), onError: vi.fn() },
      isLazy: true,
      preventDefault: vi.fn(),
    };
    emit(ins, 'contentLoad', evSized);
    expect(evSized.preventDefault).not.toHaveBeenCalled();
    const evHtml = {
      content: { type: 'html', data: { html: '<p></p>' }, load: vi.fn(), onError: vi.fn() },
      isLazy: false,
      preventDefault: vi.fn(),
    };
    emit(ins, 'contentLoad', evHtml);
    expect(evHtml.preventDefault).not.toHaveBeenCalled();
  });
});
