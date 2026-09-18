import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Hls from 'hls.js';
import { PlayerDialog } from './PlayerDialog';

// hls.js 桩：捕获实例方法与 ERROR 回调（降级链测试需要手动触发错误）
interface HlsStubInstance {
  loadSource: ReturnType<typeof vi.fn>;
  attachMedia: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  recoverMediaError: ReturnType<typeof vi.fn>;
  onError: ((evt: string, data: { fatal: boolean; type: string; details: string }) => void) | null;
  emitError: (data: { fatal: boolean; type: string; details: string }) => void;
}
const instances: HlsStubInstance[] = [];
let supported = true;

vi.mock('hls.js', () => {
  class HlsStub implements HlsStubInstance {
    static readonly Events = { ERROR: 'hlsError' };
    static readonly ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    static readonly ErrorDetails = {
      MANIFEST_LOAD_ERROR: 'manifestLoadError',
      MANIFEST_LOAD_TIMEOUT: 'manifestLoadTimeout',
      MANIFEST_PARSING_ERROR: 'manifestParsingError',
      LEVEL_LOAD_ERROR: 'levelLoadError',
      LEVEL_LOAD_TIMEOUT: 'levelLoadTimeout',
    };
    static isSupported() {
      return supported;
    }
    loadSource = vi.fn();
    attachMedia = vi.fn();
    destroy = vi.fn();
    recoverMediaError = vi.fn();
    onError: ((evt: string, data: { fatal: boolean; type: string; details: string }) => void) | null = null;
    constructor() {
      instances.push(this);
    }
    on(_evt: string, cb: (evt: string, data: { fatal: boolean; type: string; details: string }) => void) {
      this.onError = cb;
    }
    /** 测试辅助：按 hls.js 真实签名 (evt, data) 触发 ERROR 回调 */
    emitError(data: { fatal: boolean; type: string; details: string }) {
      this.onError?.('hlsError', data);
    }
  }
  return { default: HlsStub };
});

function lastInstance(): HlsStubInstance {
  return instances.at(-1) as HlsStubInstance;
}

beforeEach(() => {
  instances.length = 0;
  supported = true;
});

function renderDialog(id = 7) {
  // dialog.showModal 在 happy-dom 中可用性不稳定，绕开：直接渲染内容断言 video 行为
  const r = render(<PlayerDialog item={{ id, path: 'D:/v/a.mp4' }} onClose={() => {}} />);
  const video = () => r.container.querySelector('video') as HTMLVideoElement;
  return { ...r, video };
}

describe('PlayerDialog 播放链路', () => {
  it('hls.js 可用：加载 m3u8 并挂载 video', async () => {
    expect(Hls.isSupported()).toBe(true);
    renderDialog();
    const h = lastInstance();
    expect(h.loadSource).toHaveBeenCalledWith('/stream/7/index.m3u8');
    await waitFor(() => expect(h.attachMedia).toHaveBeenCalled());
  });

  it('fatal manifest 网络错误 → 销毁 hls 并降级直连 /stream/:id', async () => {
    const { video } = renderDialog();
    const h = lastInstance();
    expect(h.onError).toBeTruthy();
    h.emitError({ fatal: true, type: 'networkError', details: 'manifestLoadError' });
    expect(h.destroy).toHaveBeenCalled();
    await waitFor(() => expect(video().getAttribute('src')).toBe('/stream/7'));
  });

  it('非 fatal 或分段级错误不降级', () => {
    const { video } = renderDialog();
    const h = lastInstance();
    h.emitError({ fatal: false, type: 'networkError', details: 'manifestLoadError' });
    h.emitError({ fatal: true, type: 'networkError', details: 'fragLoadError' });
    expect(h.destroy).not.toHaveBeenCalled();
    expect(video().getAttribute('src')).toBeNull();
  });

  it('媒体错误走 recoverMediaError，不降级', () => {
    const { video } = renderDialog();
    const h = lastInstance();
    h.emitError({ fatal: true, type: 'mediaError', details: 'bufferStalledError' });
    expect(h.recoverMediaError).toHaveBeenCalled();
    expect(h.destroy).not.toHaveBeenCalled();
    expect(video().getAttribute('src')).toBeNull();
  });

  it('不支持 MSE 且不支持原生 HLS → 直连降级', () => {
    supported = false;
    const { video } = renderDialog();
    expect(video().getAttribute('src')).toBe('/stream/7');
    expect(instances).toHaveLength(0);
  });
});
