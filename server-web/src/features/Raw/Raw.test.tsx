import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelRawScan,
  fetchRawFiles,
  fetchRawMissing,
  fetchRawVolumes,
  resolveRawMissing,
  startRawScan,
} from '@/lib/api';
import type { RawFileRow, RawFilesResponse, RawScanStatus, RawVolumesResponse } from '@/lib/types';
import { Raw } from './Raw';

vi.mock('@/lib/api', () => ({
  fetchRawVolumes: vi.fn(),
  startRawScan: vi.fn(),
  cancelRawScan: vi.fn(),
  fetchRawFiles: vi.fn(),
  fetchRawMissing: vi.fn(),
  resolveRawMissing: vi.fn(),
}));

const mockedVolumes = vi.mocked(fetchRawVolumes);
const mockedStart = vi.mocked(startRawScan);
const mockedCancel = vi.mocked(cancelRawScan);
const mockedFiles = vi.mocked(fetchRawFiles);
const mockedMissing = vi.mocked(fetchRawMissing);
const mockedResolve = vi.mocked(resolveRawMissing);

// EventSource 桩：记录实例并允许测试注入 snapshot/progress/done 事件
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, (ev: { data: string }) => void>();
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: { data: string }) => void) {
    this.listeners.set(type, cb);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: RawScanStatus) {
    this.listeners.get(type)?.({ data: JSON.stringify(data) });
  }
}

function row(partial: Partial<RawFileRow> = {}): RawFileRow {
  return {
    id: 7,
    path: 'd:/rawfiles/a.mp4',
    hash: 'h',
    name: 'a',
    ext: 'mp4',
    type: 'video',
    size: 1024,
    mtime: 1700000000000,
    volume: 'd:',
    missing: false,
    pending_missing: false,
    archived: false,
    first_seen: 1,
    last_seen: 2,
    ...partial,
  };
}

function volumesResp(partial: Partial<RawVolumesResponse> = {}): RawVolumesResponse {
  return { ok: true, volumes: [{ volume: 'd:', total: 1000, free: 400 }], lastSelection: null, ...partial };
}

function filesResp(partial: Partial<RawFilesResponse> = {}): RawFilesResponse {
  return { ok: true, total: 1, items: [row()], volumes: [{ volume: 'd:', files: 1, videos: 1, images: 0 }], ...partial };
}

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeEventSource as unknown as typeof EventSource);
  FakeEventSource.instances.length = 0;
  mockedVolumes.mockReset().mockResolvedValue(volumesResp());
  mockedFiles.mockReset().mockResolvedValue(filesResp());
  mockedMissing.mockReset().mockResolvedValue({ ok: true, items: [] });
  mockedStart.mockReset().mockResolvedValue({ ok: true, started: true });
  mockedCancel.mockReset().mockResolvedValue({ ok: true, canceled: true });
  mockedResolve.mockReset().mockResolvedValue({ ok: true, affected: 1 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderRaw(over: { volumes?: Partial<RawVolumesResponse> } = {}) {
  const onStat = vi.fn();
  const onPlay = vi.fn();
  const r = render(<Raw onStat={onStat} onPlay={onPlay} />);
  return { ...r, onStat, onPlay };
}

describe('Raw 扫描面板', () => {
  it('渲染磁盘卡（容量 + 勾选切换）；无盘符显示引导', async () => {
    renderRaw();
    const card = await screen.findByRole('button', { name: '盘符 d:' });
    expect(card.textContent).toContain('剩 400 B');
    fireEvent.click(card);
    expect(screen.getByText(/开始扫描（1 个盘）/)).toBeTruthy();
  });

  it('上次勾选恢复（盘符交集 + 类型）', async () => {
    mockedVolumes.mockResolvedValue(
      volumesResp({
        volumes: [
          { volume: 'd:', total: 1000, free: 400 },
          { volume: 'e:', total: 2000, free: 100 },
        ],
        lastSelection: { volumes: ['d:', 'x:'], types: ['image'] },
      }),
    );
    renderRaw();
    await screen.findByRole('button', { name: '盘符 e:' });
    expect(screen.getByRole('button', { name: '盘符 d:' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '盘符 e:' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: '视频' }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('button', { name: '图片' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('开始扫描携带选中盘符与类型；未勾选时按钮禁用', async () => {
    renderRaw();
    const btn = (await screen.findByText(/开始扫描/)) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '盘符 d:' }));
    fireEvent.click(btn);
    await waitFor(() => expect(mockedStart).toHaveBeenCalledWith(['d:'], ['video', 'image']));
  });

  it('SSE progress → 进度与取消按钮；done → 结果摘要 + 刷新列表', async () => {
    renderRaw();
    await screen.findByRole('button', { name: '盘符 d:' });
    const es = FakeEventSource.instances.at(-1) as FakeEventSource;
    expect(es.url).toBe('/api/raw/scan/events');
    act(() => {
      es.emit('progress', { running: true, currentVolume: 'd:', scanned: 5, videos: 3, images: 2, startedAt: 1 });
    });
    expect(screen.getByText(/正在扫描/).textContent).toContain('d:');
    expect(screen.getByText(/已处理/).textContent).toContain('5');
    fireEvent.click(screen.getByText('取消扫描'));
    await waitFor(() => expect(mockedCancel).toHaveBeenCalled());
    act(() => {
      es.emit('done', {
        running: false,
        lastResult: { ms: 1500, newCount: 3, updatedCount: 1, movedCount: 0, missingCount: 0, warnings: [], canceled: false },
      });
    });
    expect(screen.getByText(/上次扫描：新增 3 · 更新 1/)).toBeTruthy();
    await waitFor(() => expect(mockedFiles.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('SSE done 带待决策消失 → 横幅 + 清单 + 批量决策', async () => {
    const gone = row({ id: 9, path: 'd:/rawfiles/gone.mp4', name: 'gone' });
    mockedMissing.mockResolvedValue({ ok: true, items: [gone] });
    renderRaw();
    await screen.findByRole('button', { name: '盘符 d:' });
    const es = FakeEventSource.instances.at(-1) as FakeEventSource;
    act(() => {
      es.emit('done', {
        running: false,
        lastResult: { ms: 10, newCount: 1, updatedCount: 0, movedCount: 0, missingCount: 1, warnings: [], canceled: false },
      });
    });
    // done 后拉取待决策清单（refreshMissing）→ 横幅出现
    await screen.findByText(/发现 1 个文件已消失/);
    fireEvent.click(screen.getByText('查看清单'));
    expect(await screen.findByText(/d:\/rawfiles\/gone.mp4/)).toBeTruthy();
    fireEvent.click(screen.getByText('全部标记为已消失'));
    await waitFor(() => expect(mockedResolve).toHaveBeenCalledWith('mark'));
  });

  it('启动扫描 409 报错展示', async () => {
    mockedStart.mockRejectedValue(new Error('已有扫描任务进行中'));
    renderRaw();
    fireEvent.click(await screen.findByRole('button', { name: '盘符 d:' }));
    fireEvent.click(screen.getByText(/开始扫描/));
    expect(await screen.findByText('已有扫描任务进行中')).toBeTruthy();
  });
});

describe('Raw 文件浏览', () => {
  it('视频卡：图标 + ext 徽标；点击播放回调携带直连与 HLS 源（mp4 直连优先）', async () => {
    const { onPlay } = renderRaw();
    fireEvent.click(await screen.findByRole('button', { name: '播放 a' }));
    expect(onPlay).toHaveBeenCalledWith({
      path: 'd:/rawfiles/a.mp4',
      direct: '/api/raw/file/7/content',
      hls: '/api/raw/file/7/index.m3u8',
      preferDirect: true,
    });
  });

  it('图片卡：缩略图走 content 端点，无播放按钮', async () => {
    mockedFiles.mockResolvedValue(
      filesResp({ items: [row({ id: 9, type: 'image', ext: 'jpg', name: 'p', path: 'd:/rawfiles/p.jpg' })] }),
    );
    const { container } = renderRaw();
    await screen.findByText('p');
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/raw/file/9/content');
    expect(container.querySelector('[aria-label^="播放"]')).toBeNull();
    expect(container.querySelector('.badge')?.textContent).toBe('图片');
  });

  it('非原生格式（avi）播放不 preferDirect；mkv 直连优先', async () => {
    mockedFiles.mockResolvedValue(
      filesResp({ items: [row({ ext: 'avi' }), row({ id: 8, name: 'b', ext: 'mkv', path: 'd:/rawfiles/b.mkv' })] }),
    );
    const { onPlay } = renderRaw();
    fireEvent.click(await screen.findByRole('button', { name: '播放 a' }));
    expect(onPlay).toHaveBeenLastCalledWith(
      expect.objectContaining({ preferDirect: false, hls: '/api/raw/file/7/index.m3u8' }),
    );
    fireEvent.click(screen.getByRole('button', { name: '播放 b' }));
    expect(onPlay).toHaveBeenLastCalledWith(expect.objectContaining({ preferDirect: true }));
  });

  it('类型/盘符/消失筛选携带参数并回到第一页', async () => {
    renderRaw();
    await screen.findByText('a');
    fireEvent.change(screen.getByLabelText('原始资料类型'), { target: { value: 'image' } });
    await waitFor(() => expect(mockedFiles).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'image', page: 1 })));
    fireEvent.change(screen.getByLabelText('原始资料盘符'), { target: { value: 'd:' } });
    await waitFor(() => expect(mockedFiles).toHaveBeenLastCalledWith(expect.objectContaining({ volume: 'd:', page: 1 })));
    fireEvent.change(screen.getByLabelText('消失状态'), { target: { value: 'only' } });
    await waitFor(() => expect(mockedFiles).toHaveBeenLastCalledWith(expect.objectContaining({ missing: 'only', page: 1 })));
  });

  it('头部统计上报资料总数', async () => {
    const { onStat } = renderRaw();
    await screen.findByText('a');
    expect(onStat).toHaveBeenCalledWith('资料 1 · 视频 1 · 图片 0');
  });

  it('archived 卡片：标题=当前名（path 末段），副行显示最初名', async () => {
    mockedFiles.mockResolvedValue(
      filesResp({ items: [row({ name: 'origin', path: 'd:/rawfiles/renamed.mp4', archived: true })] }),
    );
    renderRaw();
    await screen.findByText('renamed');
    expect(screen.getByText('最初：origin')).toBeTruthy();
  });

  it('页面不渲染变更记录区块（已迁移至归档资料页）', async () => {
    renderRaw();
    await screen.findByText('a');
    expect(screen.queryByText('变更记录')).toBeNull();
  });

  it('done 结果摘要含合并移动数', async () => {
    renderRaw();
    await screen.findByRole('button', { name: '盘符 d:' });
    const es = FakeEventSource.instances.at(-1) as FakeEventSource;
    act(() => {
      es.emit('done', {
        running: false,
        lastResult: { ms: 1500, newCount: 1, updatedCount: 2, movedCount: 3, missingCount: 0, warnings: [], canceled: false },
      });
    });
    expect(screen.getByText(/合并移动 3/)).toBeTruthy();
  });
});
