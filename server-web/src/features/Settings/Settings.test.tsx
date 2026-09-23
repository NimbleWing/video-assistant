import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchConfig, fetchLog, saveConfig } from '@/lib/api';
import { Settings } from './Settings';

vi.mock('@/lib/api', () => ({
  fetchConfig: vi.fn(),
  saveConfig: vi.fn(),
  fetchLog: vi.fn(),
}));

const configMock = vi.mocked(fetchConfig);
const saveMock = vi.mocked(saveConfig);
const logMock = vi.mocked(fetchLog);

function config(partial: Partial<Awaited<ReturnType<typeof fetchConfig>>> = {}) {
  return {
    ok: true as const,
    ffmpegPath: '',
    ffmpeg: { available: true, path: 'ffmpeg', source: 'path' as const },
    ...partial,
  };
}

beforeEach(() => {
  configMock.mockReset();
  saveMock.mockReset();
  logMock.mockReset();
});

describe('Settings', () => {
  it('挂载时加载 ffmpeg 配置/状态', async () => {
    configMock.mockResolvedValue(
      config({ ffmpegPath: 'D:\\Tools\\ffmpeg.exe', ffmpeg: { available: true, path: 'D:\\Tools\\ffmpeg.exe', source: 'config' } }),
    );
    render(<Settings />);
    const ta = (await screen.findByRole('textbox', { name: 'ffmpeg 路径' })) as HTMLInputElement;
    expect(ta.value).toBe('D:\\Tools\\ffmpeg.exe');
    expect(await screen.findByText('已就绪：D:\\Tools\\ffmpeg.exe（配置）')).toBeTruthy();
  });

  it('ffmpeg 缺失时展示降级提示', async () => {
    configMock.mockResolvedValue(config({ ffmpeg: { available: false, path: '', source: null } }));
    render(<Settings />);
    expect(await screen.findByText(/未检测到 ffmpeg：HLS 流不可用/)).toBeTruthy();
  });

  it('保存配置：携带 ffmpegPath，保存后刷新状态', async () => {
    configMock.mockResolvedValueOnce(config()); // 挂载加载
    configMock.mockResolvedValue(config({ ffmpeg: { available: true, path: 'D:\\f.exe', source: 'config' } })); // 保存后刷新
    saveMock.mockResolvedValue({ ok: true, warnings: [] });
    render(<Settings />);
    fireEvent.change(await screen.findByRole('textbox', { name: 'ffmpeg 路径' }), { target: { value: 'D:\\f.exe' } });
    fireEvent.click(screen.getByText('保存配置'));
    await waitFor(() => expect(saveMock).toHaveBeenCalledWith('D:\\f.exe'));
    expect(await screen.findByText('已保存')).toBeTruthy();
    expect(await screen.findByText('已就绪：D:\\f.exe（配置）')).toBeTruthy();
  });

  it('保存配置：警告不阻断，逐条展示', async () => {
    configMock.mockResolvedValue(config());
    saveMock.mockResolvedValue({ ok: true, warnings: ['D:\\f.exe 不存在或不可访问'] });
    render(<Settings />);
    fireEvent.click(await screen.findByText('保存配置'));
    expect(await screen.findByText('D:\\f.exe 不存在或不可访问')).toBeTruthy();
  });

  it('查看日志：展示 tail', async () => {
    configMock.mockResolvedValue(config());
    logMock.mockResolvedValue({ ok: true, lines: 2, tail: 'L1\nL2' });
    render(<Settings />);
    fireEvent.click(await screen.findByText('查看日志'));
    await waitFor(() => expect(document.querySelector('pre')?.textContent).toContain('L1\nL2'));
  });
});
