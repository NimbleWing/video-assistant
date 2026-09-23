import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchActresses, fetchStudios, fetchTags, fetchWorks, setVideoRating } from '@/lib/api';
import type { ActressesResponse, StudiosResponse, TagsResponse, VideoRow, WorksResponse } from '@/lib/types';
import { Video } from './Video';

vi.mock('@/lib/api', () => ({
  fetchWorks: vi.fn(),
  fetchActresses: vi.fn(),
  fetchTags: vi.fn(),
  fetchStudios: vi.fn(),
  setVideoRating: vi.fn(),
}));

const mockedWorks = vi.mocked(fetchWorks);
const mockedActresses = vi.mocked(fetchActresses);
const mockedTags = vi.mocked(fetchTags);
const mockedStudios = vi.mocked(fetchStudios);
const mockedRate = vi.mocked(setVideoRating);

function work(partial: Partial<VideoRow> = {}): VideoRow {
  return {
    id: 11,
    kind: 'single',
    title: '标题甲',
    subtitle: '副标题乙',
    code: 'ABC-123',
    rating: 37, // 加分配额：展示分 = 基础分 50 + 加分 37 = 87
    base_rating: 50,
    video_file_id: 7,
    cover_file_id: 8,
    created_at: 1700000000000,
    video_file: { id: 7, path: 'd:/archives/日本/A子/ABC-123 标题甲.mp4', ext: 'mp4', size: 1024, duration: 1423, width: 1920, height: 1080 },
    actresses: [{ id: 1, name: 'A子' }],
    tags: [
      { id: 1, name: '标签一', sort: 1 },
      { id: 2, name: '标签二', sort: 2 },
    ],
    studios: [{ id: 1, name: '片商X' }],
    countries: [{ id: 1, name: '日本' }],
    ...partial,
  };
}

function boot(over: { onStat?: (t: string) => void; onPlay?: (src: unknown) => void; onView?: (items: unknown, i: number) => void } = {}) {
  render(
    <Video
      onStat={over.onStat ?? (() => {})}
      onPlay={(over.onPlay ?? (() => {})) as never}
      onView={(over.onView ?? (() => {})) as never}
    />,
  );
}

beforeEach(() => {
  mockedWorks.mockReset().mockResolvedValue({ ok: true, total: 1, items: [work()] } satisfies WorksResponse);
  mockedActresses.mockReset().mockResolvedValue({
    ok: true,
    items: [
      {
        id: 5, name: 'B美', country_id: 1, country_name: '日本', rating: null, disk: 'd:',
        avatar_file_id: null, aliases: [], tags: [], video_count: 0,
      },
    ],
  } satisfies ActressesResponse);
  mockedTags.mockReset().mockResolvedValue({
    ok: true,
    items: [{ id: 9, name: '标签三', sort: 1, video_count: 0, actor_count: 0 }],
  } satisfies TagsResponse);
  mockedStudios.mockReset().mockResolvedValue({
    ok: true,
    items: [{ id: 3, name: '片商Y', has_logo: false, video_count: 0, actor_count: 0 }],
  } satisfies StudiosResponse);
});

describe('Video 视频库页', () => {
  it('渲染卡片（评分/番号/时长/分辨率/标题/副标题/演员/标签/国家/片商/大小）与统计；请求固定 kind=single', async () => {
    const onStat = vi.fn();
    boot({ onStat });
    expect(await screen.findByText('标题甲')).toBeTruthy();
    expect(screen.getByText('副标题乙')).toBeTruthy();
    expect(screen.getByText('ABC-123')).toBeTruthy();
    expect(screen.getAllByText('23:43')).toHaveLength(2); // 角标 + 底部行
    expect(screen.getByText('1080p')).toBeTruthy();
    expect(screen.getByText('87')).toBeTruthy(); // 评分环
    expect(screen.getByText('1.0 KB')).toBeTruthy();
    expect(screen.getByText('A子')).toBeTruthy();
    expect(screen.getByText('标签一')).toBeTruthy();
    expect(screen.getByText('日本')).toBeTruthy();
    expect(screen.getByText('片商X')).toBeTruthy();
    expect(onStat).toHaveBeenCalledWith('单片 1');
    expect(mockedWorks).toHaveBeenCalledWith(expect.objectContaining({ kind: 'single', page: 1, size: 50 }));
  });

  it('空态引导文案', async () => {
    mockedWorks.mockResolvedValue({ ok: true, total: 0, items: [] } satisfies WorksResponse);
    boot();
    expect(await screen.findByText(/暂无归档作品/)).toBeTruthy();
  });

  it('无封面渲染中性占位（与「无法访问」区分）', async () => {
    mockedWorks.mockResolvedValue({ ok: true, total: 1, items: [work({ cover_file_id: null })] } satisfies WorksResponse);
    boot();
    expect(await screen.findByText('无封面')).toBeTruthy();
    expect(screen.queryByText('封面无法访问')).toBeNull();
  });

  it('封面加载失败（行状态过期）切换 err 占位', async () => {
    boot();
    fireEvent.error(await screen.findByRole('img', { name: '标题甲' }));
    expect(await screen.findByText('封面无法访问')).toBeTruthy();
  });

  it('点击封面看大图（onView 当前条目）', async () => {
    const onView = vi.fn();
    boot({ onView });
    fireEvent.click(await screen.findByRole('img', { name: '标题甲' }));
    expect(onView).toHaveBeenCalledWith(
      [{ src: '/api/raw/file/8/content', alt: '标题甲' }],
      0,
    );
  });

  it('评分环点击开改分弹层，slider 修改落库并就地更新', async () => {
    mockedRate.mockResolvedValue({ ok: true, item: work({ rating: 16 }) });
    boot();
    fireEvent.click(await screen.findByRole('button', { name: /评分 87/ }));
    // 加分上限 = 100 − 基础分 50 = 50；拖到 16 → 落库加分配额 16 → 展示分 50+16=66
    const slider = screen.getByLabelText('评分') as HTMLInputElement;
    expect(slider.max).toBe('50');
    fireEvent.change(slider, { target: { value: '16' } });
    await waitFor(() => expect(mockedRate).toHaveBeenCalledWith(11, 16));
    expect(await screen.findByText('66')).toBeTruthy();
  });

  it('播放探活成功 → 双源 onPlay（mp4 直连优先）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const onPlay = vi.fn();
    boot({ onPlay });
    fireEvent.click(await screen.findByRole('button', { name: '播放 标题甲' }));
    await waitFor(() =>
      expect(onPlay).toHaveBeenCalledWith({
        path: 'd:/archives/日本/A子/ABC-123 标题甲.mp4',
        direct: '/api/raw/file/7/content',
        hls: '/api/raw/file/7/index.m3u8',
        preferDirect: true,
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith('/api/raw/file/7/content', { method: 'HEAD' });
    vi.unstubAllGlobals();
  });

  it('探活失败 → err 横幅提示文件无法访问，不开播放弹窗', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const onPlay = vi.fn();
    boot({ onPlay });
    fireEvent.click(await screen.findByRole('button', { name: '播放 标题甲' }));
    expect(await screen.findByText(/文件无法访问或已丢失/)).toBeTruthy();
    expect(onPlay).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('video_file 悬空（防御）→ 横幅提示记录缺失', async () => {
    mockedWorks.mockResolvedValue({ ok: true, total: 1, items: [work({ video_file: null })] } satisfies WorksResponse);
    const onPlay = vi.fn();
    boot({ onPlay });
    fireEvent.click(await screen.findByRole('button', { name: '播放 标题甲' }));
    expect(await screen.findByText(/文件记录缺失/)).toBeTruthy();
    expect(onPlay).not.toHaveBeenCalled();
  });

  it('演员/标签/片商筛选携带参数（字典下拉）', async () => {
    boot();
    await screen.findByText('标题甲');
    await screen.findByText('B美'); // 字典加载完成
    fireEvent.change(screen.getByLabelText('演员筛选'), { target: { value: '5' } });
    await waitFor(() => expect(mockedWorks).toHaveBeenLastCalledWith(expect.objectContaining({ actressId: 5 })));
    fireEvent.change(screen.getByLabelText('标签筛选'), { target: { value: '9' } });
    await waitFor(() => expect(mockedWorks).toHaveBeenLastCalledWith(expect.objectContaining({ tagId: 9 })));
    fireEvent.change(screen.getByLabelText('片商筛选'), { target: { value: '3' } });
    await waitFor(() => expect(mockedWorks).toHaveBeenLastCalledWith(expect.objectContaining({ studioId: 3 })));
  });
});
