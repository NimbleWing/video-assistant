import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRawArchived, fetchRawEvents } from '@/lib/api';
import type { ArchivedItem, RawArchivedResponse, RawEventItem } from '@/lib/types';
import { Archive } from './Archive';

vi.mock('@/lib/api', () => ({
  fetchRawArchived: vi.fn(),
  fetchRawEvents: vi.fn(),
}));

const mockedArchived = vi.mocked(fetchRawArchived);
const mockedEvents = vi.mocked(fetchRawEvents);

function item(partial: Partial<ArchivedItem> = {}): ArchivedItem {
  return {
    id: 7,
    path: 'd:/rawfiles/sub/renamed.mp4',
    hash: 'h',
    name: 'origin',
    ext: 'mp4',
    type: 'video',
    size: 1024,
    mtime: 1700000000000,
    volume: 'd:',
    missing: false,
    pending_missing: false,
    archived: true,
    first_seen: 1,
    last_seen: 2,
    latest_name: 'renamed',
    event_count: 2,
    ...partial,
  };
}

function resp(partial: Partial<RawArchivedResponse> = {}): RawArchivedResponse {
  return { ok: true, total: 1, items: [item()], volumes: [{ volume: 'd:', files: 1, videos: 1, images: 0 }], ...partial };
}

function ev(partial: Partial<RawEventItem> = {}): RawEventItem {
  return {
    id: 1,
    kind: 'rename',
    result: '名称从「origin」改为「renamed」',
    created_at: 1700000000000,
    file: null,
    ...partial,
  };
}

beforeEach(() => {
  mockedArchived.mockReset().mockResolvedValue(resp());
  mockedEvents.mockReset().mockResolvedValue({
    ok: true,
    total: 2,
    items: [ev(), ev({ id: 2, kind: 'move', result: '从「d:/rawfiles/origin.mp4」移动到「d:/rawfiles/sub/renamed.mp4」' })],
  });
});

describe('Archive 归档资料页', () => {
  it('渲染归档卡片（当前名 + 最初名副行 + 变更记录入口）与头部统计', async () => {
    const onStat = vi.fn();
    render(<Archive onStat={onStat} onPlay={() => {}} />);
    expect(await screen.findByText('renamed')).toBeTruthy();
    expect(screen.getByText('最初：origin')).toBeTruthy();
    expect(screen.getByText('变更记录 →')).toBeTruthy();
    expect(onStat).toHaveBeenCalledWith('归档 1 · 视频 1 · 图片 0');
    expect(screen.queryByRole('button', { name: /^删除文件/ })).toBeNull(); // 归档页不提供删除入口
  });

  it('空态引导文案', async () => {
    mockedArchived.mockResolvedValue(resp({ total: 0, items: [], volumes: [] }));
    render(<Archive onStat={() => {}} onPlay={() => {}} />);
    expect(await screen.findByText(/暂无归档文件/)).toBeTruthy();
  });

  it('点击「变更记录」→ 弹窗加载该文件事件时间线', async () => {
    render(<Archive onStat={() => {}} onPlay={() => {}} />);
    fireEvent.click(await screen.findByText('变更记录 →'));
    await waitFor(() =>
      expect(mockedEvents).toHaveBeenCalledWith(expect.objectContaining({ fileId: 7 })),
    );
    expect(await screen.findByText(/名称从「origin」改为「renamed」/)).toBeTruthy();
    expect(screen.getByText(/从「d:\/rawfiles\/origin.mp4」移动到/)).toBeTruthy(); // 第二条事件
    expect(screen.getByText('移动')).toBeTruthy();
    expect(screen.getByText('最初名：origin')).toBeTruthy();
  });

  it('搜索防抖与类型/盘符筛选携带参数', async () => {
    render(<Archive onStat={() => {}} onPlay={() => {}} />);
    await screen.findByText('renamed');
    fireEvent.change(screen.getByLabelText('搜索归档资料'), { target: { value: ' origin ' } });
    await waitFor(
      () => expect(mockedArchived).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'origin', page: 1 })),
      { timeout: 2000 },
    );
    fireEvent.change(screen.getByLabelText('归档类型'), { target: { value: 'image' } });
    await waitFor(() => expect(mockedArchived).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'image' })));
    fireEvent.change(screen.getByLabelText('归档盘符'), { target: { value: 'd:' } });
    await waitFor(() => expect(mockedArchived).toHaveBeenLastCalledWith(expect.objectContaining({ volume: 'd:' })));
  });

  it('视频卡片点击播放携带双源（mp4 直连优先）', async () => {
    const onPlay = vi.fn();
    render(<Archive onStat={() => {}} onPlay={onPlay} />);
    fireEvent.click(await screen.findByRole('button', { name: '播放 renamed' }));
    expect(onPlay).toHaveBeenCalledWith({
      path: 'd:/rawfiles/sub/renamed.mp4',
      direct: '/api/raw/file/7/content',
      hls: '/api/raw/file/7/index.m3u8',
      preferDirect: true,
    });
  });
});
