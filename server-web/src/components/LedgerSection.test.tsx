import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchDownloads } from '../api';
import type { DownloadItem, DownloadsResponse } from '../types';
import { LedgerSection } from './LedgerSection';

vi.mock('../api', () => ({ fetchDownloads: vi.fn() }));
const mocked = vi.mocked(fetchDownloads);

function entry(partial: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 1,
    site: 'rou.video',
    video_id: 'abc',
    page_path: '/v/abc',
    name: '标题',
    series_name: '剧集',
    quality: 1080,
    filename: '剧集/标题.mp4',
    status: 'failed',
    error: null,
    attempts: 2,
    size: null,
    created_at: 1,
    updated_at: 1700000000000,
    ...partial,
  };
}

function resp(partial: Partial<DownloadsResponse> = {}): DownloadsResponse {
  return {
    ok: true,
    total: 1,
    items: [entry()],
    counts: { failed: 2, complete: 3 },
    ...partial,
  };
}

beforeEach(() => {
  mocked.mockReset();
});

describe('LedgerSection', () => {
  it('默认拉取 failed 并渲染行与计数', async () => {
    mocked.mockResolvedValue(resp());
    render(<LedgerSection />);
    expect(mocked).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', page: 1, size: 50 }));
    expect(await screen.findByText('标题')).toBeTruthy();
    expect(screen.getByText('剧集')).toBeTruthy();
    expect(screen.getByText('2', { selector: 'td' })).toBeTruthy(); // attempts
    expect(screen.getByText('1080')).toBeTruthy();
    // chips：全部 5、failed 2、complete 3
    expect(screen.getByText('全部').parentElement?.textContent).toContain('5');
    expect(screen.getByText('failed', { selector: 'button' }).textContent).toContain('2');
    expect(screen.getByText('complete', { selector: 'button' }).textContent).toContain('3');
  });

  it('错误信息优先于大小展示', async () => {
    mocked.mockResolvedValue(resp({ items: [entry({ error: '网络中断' })] }));
    render(<LedgerSection />);
    expect(await screen.findByText('网络中断')).toBeTruthy();
  });

  it('点击 chip 切换 status 并回到第一页', async () => {
    mocked.mockResolvedValue(resp({ total: 120 }));
    render(<LedgerSection />);
    await screen.findByText('标题');
    fireEvent.click(screen.getByText('complete'));
    await waitFor(() =>
      expect(mocked).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'complete', page: 1 })),
    );
  });

  it('翻页', async () => {
    mocked.mockResolvedValue(resp({ total: 120 }));
    render(<LedgerSection />);
    await screen.findByText('标题');
    fireEvent.click(screen.getByText('下一页'));
    await waitFor(() => expect(mocked).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
  });

  it('空结果显示没有记录', async () => {
    mocked.mockResolvedValue(resp({ total: 0, items: [] }));
    render(<LedgerSection />);
    expect(await screen.findByText('没有记录')).toBeTruthy();
  });
});
