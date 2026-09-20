import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearStudioLogo,
  createStudio,
  deleteStudio,
  fetchStudios,
  renameStudio,
  setStudioLogo,
} from '@/lib/api';
import type { StudioRow } from '@/lib/types';
import { Studio, fileToB64 } from './Studio';

vi.mock('@/lib/api', () => ({
  fetchStudios: vi.fn(),
  createStudio: vi.fn(),
  renameStudio: vi.fn(),
  deleteStudio: vi.fn(),
  setStudioLogo: vi.fn(),
  clearStudioLogo: vi.fn(),
}));
const mockedFetch = vi.mocked(fetchStudios);
const mockedCreate = vi.mocked(createStudio);
const mockedRename = vi.mocked(renameStudio);
const mockedDelete = vi.mocked(deleteStudio);
const mockedSetLogo = vi.mocked(setStudioLogo);
const mockedClearLogo = vi.mocked(clearStudioLogo);

function row(partial: Partial<StudioRow> = {}): StudioRow {
  return { id: 1, name: '片商A', has_logo: false, video_count: 0, actor_count: 0, ...partial };
}

async function boot(items: StudioRow[]) {
  mockedFetch.mockResolvedValue({ ok: true, items });
  render(<Studio />);
  if (items.length) await screen.findByText(items[0]!.name);
  else await screen.findByText('还没有片商，添加第一个吧');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fileToB64', () => {
  it('文件 → 无 data: 前缀的 base64', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const file = new File([bytes], 'x.png', { type: 'image/png' });
    const expected = btoa(String.fromCharCode(...bytes));
    await expect(fileToB64(file)).resolves.toBe(expected);
  });
});

describe('Studio', () => {
  it('无 logo 渲染名字首字占位；有 logo 渲染专用端点 img；计数展示', async () => {
    await boot([row(), row({ id: 2, name: '片商B', has_logo: true })]);
    expect(screen.getByText('片')).toBeTruthy(); // 首字占位
    const img = screen.getByAltText('片商B logo') as HTMLImageElement;
    expect(img.src).toContain('/api/studios/2/logo?v=');
    expect(screen.getAllByText('视频 0')).toHaveLength(2);
    expect(screen.getAllByText('演员 0')).toHaveLength(2);
  });

  it('空库显示空态', async () => {
    await boot([]);
    expect(screen.getByText('还没有片商，添加第一个吧')).toBeTruthy();
  });

  it('添加：trim 提交并清空输入、刷新', async () => {
    await boot([]);
    mockedFetch.mockResolvedValue({ ok: true, items: [row({ id: 5, name: '片商C' })] });
    mockedCreate.mockResolvedValue({ ok: true, item: row({ id: 5, name: '片商C' }) });
    const input = screen.getByPlaceholderText('片商名（如：某制作组）');
    fireEvent.change(input, { target: { value: '  片商C  ' } });
    fireEvent.click(screen.getByText('添加'));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith('片商C'));
    await screen.findByText('片商C');
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('改名：点击名字进入编辑，Enter 提交', async () => {
    await boot([row()]);
    fireEvent.click(screen.getByText('片商A'));
    const edit = screen.getByDisplayValue('片商A') as HTMLInputElement;
    fireEvent.change(edit, { target: { value: '片商A改' } });
    mockedRename.mockResolvedValue({ ok: true, item: row({ name: '片商A改' }) });
    mockedFetch.mockResolvedValue({ ok: true, items: [row({ name: '片商A改' })] });
    fireEvent.keyDown(edit, { key: 'Enter' });
    await waitFor(() => expect(mockedRename).toHaveBeenCalledWith(1, '片商A改'));
    await screen.findByText('片商A改');
  });

  it('删除：ConfirmDialog 注明 logo 一并删除，确认后调用接口', async () => {
    await boot([row()]);
    fireEvent.click(screen.getByRole('button', { name: '删除 片商A' }));
    expect(screen.getByText('删除片商')).toBeTruthy();
    expect(screen.getByText(/logo 将一并删除/)).toBeTruthy();
    mockedDelete.mockResolvedValue({ ok: true });
    mockedFetch.mockResolvedValue({ ok: true, items: [] });
    fireEvent.click(screen.getAllByText('删除').at(-1)!);
    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith(1));
    await screen.findByText('还没有片商，添加第一个吧');
  });

  it('logo 弹窗：URL 提交走 {url}；保存成功后关闭并刷新', async () => {
    await boot([row()]);
    fireEvent.click(screen.getByRole('button', { name: '设置 logo 片商A' }));
    const urlInput = screen.getByLabelText(/粘贴图片地址/);
    fireEvent.change(urlInput, { target: { value: 'https://cdn.example.com/logo.png' } });
    mockedSetLogo.mockResolvedValue({ ok: true, item: row({ has_logo: true }) });
    mockedFetch.mockResolvedValue({ ok: true, items: [row({ has_logo: true })] });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(mockedSetLogo).toHaveBeenCalledWith(1, { url: 'https://cdn.example.com/logo.png' }));
    await screen.findByAltText('片商A logo'); // 刷新后有 logo
  });

  it('logo 弹窗：文件提交走 {b64}（FileReader 链路）', async () => {
    await boot([row()]);
    fireEvent.click(screen.getByRole('button', { name: '设置 logo 片商A' }));
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const file = new File([bytes], 'logo.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText(/上传文件/), { target: { files: [file] } });
    mockedSetLogo.mockResolvedValue({ ok: true, item: row({ has_logo: true }) });
    mockedFetch.mockResolvedValue({ ok: true, items: [row({ has_logo: true })] });
    fireEvent.click(screen.getByText('保存'));
    const expected = btoa(String.fromCharCode(...bytes));
    await waitFor(() => expect(mockedSetLogo).toHaveBeenCalledWith(1, { b64: expected }));
    await screen.findByAltText('片商A logo');
  });

  it('logo 弹窗：已有 logo 时提供「清除 logo」', async () => {
    await boot([row({ has_logo: true })]);
    fireEvent.click(screen.getByRole('button', { name: '设置 logo 片商A' }));
    expect(screen.getByAltText('片商A 当前 logo')).toBeTruthy();
    mockedClearLogo.mockResolvedValue({ ok: true });
    mockedFetch.mockResolvedValue({ ok: true, items: [row()] });
    fireEvent.click(screen.getByText('清除 logo'));
    await waitFor(() => expect(mockedClearLogo).toHaveBeenCalledWith(1));
    await screen.findByText('片'); // 占位首字回归
  });

  it('logo 弹窗：空载荷时保存按钮禁用（无提交无报错）', async () => {
    await boot([row()]);
    fireEvent.click(screen.getByRole('button', { name: '设置 logo 片商A' }));
    expect((screen.getByText('保存') as HTMLButtonElement).disabled).toBe(true);
    expect(mockedSetLogo).not.toHaveBeenCalled();
  });
});
