import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchConfig, fetchLog, saveConfig, triggerScan } from '@/lib/api';
import { Settings } from './Settings';

vi.mock('@/lib/api', () => ({
  fetchConfig: vi.fn(),
  saveConfig: vi.fn(),
  triggerScan: vi.fn(),
  fetchLog: vi.fn(),
}));

const configMock = vi.mocked(fetchConfig);
const saveMock = vi.mocked(saveConfig);
const scanMock = vi.mocked(triggerScan);
const logMock = vi.mocked(fetchLog);

beforeEach(() => {
  configMock.mockReset();
  saveMock.mockReset();
  scanMock.mockReset();
  logMock.mockReset();
});

describe('Settings', () => {
  it('挂载时加载扫描目录', async () => {
    configMock.mockResolvedValue({ ok: true, scanDirs: ['D:\\Videos', 'E:\\收藏'] });
    render(<Settings />);
    const ta = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    expect(ta.value).toBe('D:\\Videos\nE:\\收藏');
  });

  it('保存目录：拆行去空并展示结果', async () => {
    configMock.mockResolvedValue({ ok: true, scanDirs: [] });
    saveMock.mockResolvedValue({ ok: true, warnings: [] });
    render(<Settings />);
    const ta = await screen.findByRole('textbox');
    fireEvent.change(ta, { target: { value: 'D:\\Videos\n  \nE:\\x' } });
    fireEvent.click(screen.getByText('保存目录'));
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith(['D:\\Videos', 'E:\\x']));
    expect(await screen.findByText('已保存')).toBeTruthy();
  });

  it('保存目录：警告不阻断，逐条展示', async () => {
    configMock.mockResolvedValue({ ok: true, scanDirs: [] });
    saveMock.mockResolvedValue({ ok: true, warnings: ['E:\\x 不存在或不可访问'] });
    render(<Settings />);
    fireEvent.click(await screen.findByText('保存目录'));
    expect(await screen.findByText('E:\\x 不存在或不可访问')).toBeTruthy();
  });

  it('立即扫描：展示结果摘要', async () => {
    configMock.mockResolvedValue({ ok: true, scanDirs: [] });
    scanMock.mockResolvedValue({
      ok: true,
      result: { videos: 3, covers: 1, removed: 2, ms: 1500, warnings: ['跳过系统目录'] },
    });
    render(<Settings />);
    fireEvent.click(await screen.findByText('立即扫描'));
    expect(await screen.findByText(/完成：视频 3 · 封面 1 · 清理失效 2 · 耗时 1\.5s/)).toBeTruthy();
    expect(screen.getByText('跳过系统目录')).toBeTruthy();
  });

  it('查看日志：展示 tail', async () => {
    configMock.mockResolvedValue({ ok: true, scanDirs: [] });
    logMock.mockResolvedValue({ ok: true, lines: 2, tail: 'L1\nL2' });
    render(<Settings />);
    fireEvent.click(await screen.findByText('查看日志'));
    await waitFor(() => expect(document.querySelector('pre')?.textContent).toContain('L1\nL2'));
  });
});
