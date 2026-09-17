import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchVideos } from '../api';
import type { VideoItem, VideosResponse } from '../types';
import { VideosSection } from './VideosSection';

vi.mock('../api', () => ({ fetchVideos: vi.fn() }));
const mocked = vi.mocked(fetchVideos);

function item(partial: Partial<VideoItem> = {}): VideoItem {
  return {
    id: 7,
    path: 'D:/v/a.mp4',
    stem: 'a',
    ext: 'mp4',
    type: 'video',
    size: 1024,
    mtime: 1700000000000,
    volume: 'd:',
    video_id: null,
    duration: 61,
    cover_id: null,
    source: 'scanned',
    first_seen: 1,
    last_seen: 2,
    ...partial,
  };
}

function resp(partial: Partial<VideosResponse> = {}): VideosResponse {
  return { ok: true, total: 1, items: [item()], volumes: [{ volume: 'd:', videos: 2 }], ...partial };
}

beforeEach(() => {
  mocked.mockReset();
});

describe('VideosSection', () => {
  it('渲染条目并上报头部统计', async () => {
    const onStat = vi.fn();
    mocked.mockResolvedValue(resp());
    render(<VideosSection onStat={onStat} onPlay={() => {}} />);
    expect(await screen.findByText('a')).toBeTruthy();
    expect(screen.getByText('MP4')).toBeTruthy();
    expect(screen.getByText('D:/v/a.mp4')).toBeTruthy();
    expect(onStat).toHaveBeenCalledWith('视频 2 · 命中 1');
  });

  it('空结果显示引导文案', async () => {
    mocked.mockResolvedValue(resp({ total: 0, items: [], volumes: [] }));
    render(<VideosSection onStat={() => {}} onPlay={() => {}} />);
    expect(await screen.findByText('没有匹配的条目（先在设置页配置目录并扫描）')).toBeTruthy();
  });

  it('分页：首页上一页禁用，下一页翻页', async () => {
    mocked.mockResolvedValue(resp({ total: 120 }));
    render(<VideosSection onStat={() => {}} onPlay={() => {}} />);
    await screen.findByText('a');
    const prev = screen.getByText('上一页') as HTMLButtonElement;
    const next = screen.getByText('下一页') as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    expect(screen.getByText('1 / 3（共 120）')).toBeTruthy();
    fireEvent.click(next);
    await waitFor(() => expect(mocked).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
  });

  it('类型筛选切换到封面并回到第一页', async () => {
    mocked.mockResolvedValue(resp());
    render(<VideosSection onStat={() => {}} onPlay={() => {}} />);
    await screen.findByText('a');
    fireEvent.change(screen.getByLabelText('类型'), { target: { value: 'cover' } });
    await waitFor(() =>
      expect(mocked).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'cover', page: 1 })),
    );
  });

  it('盘符筛选携带 volume 参数', async () => {
    mocked.mockResolvedValue(resp());
    render(<VideosSection onStat={() => {}} onPlay={() => {}} />);
    await screen.findByText('a');
    fireEvent.change(screen.getByLabelText('盘符'), { target: { value: 'd:' } });
    await waitFor(() =>
      expect(mocked).toHaveBeenLastCalledWith(expect.objectContaining({ volume: 'd:', page: 1 })),
    );
  });

  it('搜索防抖 300ms 后携带 q 查询', async () => {
    mocked.mockResolvedValue(resp({ total: 0, items: [], volumes: [] }));
    render(<VideosSection onStat={() => {}} onPlay={() => {}} />);
    await screen.findByText('没有匹配的条目（先在设置页配置目录并扫描）');
    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '  xx  ' } });
    await waitFor(
      () => expect(mocked).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'xx', page: 1 })),
      { timeout: 2000 },
    );
  });

  it('点击卡片播放回调携带 id 与路径', async () => {
    const onPlay = vi.fn();
    mocked.mockResolvedValue(resp());
    render(<VideosSection onStat={() => {}} onPlay={onPlay} />);
    fireEvent.click(await screen.findByRole('button', { name: '播放 a' }));
    expect(onPlay).toHaveBeenCalledWith({ id: 7, path: 'D:/v/a.mp4' });
  });

  it('有关联封面时缩略图走 /stream/{cover_id}，无封面渲染占位', async () => {
    mocked.mockResolvedValue(resp({ items: [item(), item({ id: 8, stem: 'b', cover_id: 9 })] }));
    const { container } = render(<VideosSection onStat={() => {}} onPlay={() => {}} />);
    await screen.findByText('b');
    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute('src')).toBe('/stream/9');
    // a 无封面：占位 svg + hover 播放按钮仍在
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '播放 b' })).toBeTruthy();
  });

  it('封面条目：缩略图即自身且不渲染播放按钮', async () => {
    mocked.mockResolvedValue(resp({ items: [item({ type: 'cover', ext: 'jpg', duration: null, cover_id: null })] }));
    const { container } = render(<VideosSection onStat={() => {}} onPlay={() => {}} />);
    await screen.findByText('a');
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/stream/7');
    expect(container.querySelector('[aria-label^="播放"]')).toBeNull();
    expect(container.querySelector('.badge')?.textContent).toBe('封面');
  });
});
