import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTag, deleteTag, fetchTags, renameTag, reorderTags } from '@/lib/api';
import type { TagRow } from '@/lib/types';
import { Tag, insertRelativeTo } from './Tag';

vi.mock('@/lib/api', () => ({
  fetchTags: vi.fn(),
  createTag: vi.fn(),
  renameTag: vi.fn(),
  deleteTag: vi.fn(),
  reorderTags: vi.fn(),
}));
const mockedFetch = vi.mocked(fetchTags);
const mockedCreate = vi.mocked(createTag);
const mockedRename = vi.mocked(renameTag);
const mockedDelete = vi.mocked(deleteTag);
const mockedReorder = vi.mocked(reorderTags);

function row(partial: Partial<TagRow> = {}): TagRow {
  return { id: 1, name: '高清', sort: 1, video_count: 0, actor_count: 0, ...partial };
}

/** 设定初始列表并渲染（默认网格视图）。 */
async function boot(items: TagRow[]) {
  mockedFetch.mockResolvedValue({ ok: true, items });
  render(<Tag />);
  if (items.length) await screen.findByText(items[0]!.name);
  else await screen.findByText('还没有标签，添加第一个吧');
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe('insertRelativeTo（拖拽排序单点逻辑）', () => {
  const abc = [row({ id: 1, name: '甲', sort: 1 }), row({ id: 2, name: '乙', sort: 2 }), row({ id: 3, name: '丙', sort: 3 })];

  it('移到目标前', () => {
    expect(insertRelativeTo(abc, 3, 1, true).map((t) => t.id)).toEqual([3, 1, 2]);
  });
  it('移到目标后', () => {
    expect(insertRelativeTo(abc, 1, 2, false).map((t) => t.id)).toEqual([2, 1, 3]);
  });
  it('拖到自身 / 目标不存在 / 拖动项不存在 → 原序返回', () => {
    expect(insertRelativeTo(abc, 2, 2, true)).toBe(abc);
    expect(insertRelativeTo(abc, 1, 999, true).map((t) => t.id)).toEqual([1, 2, 3]);
    expect(insertRelativeTo(abc, 999, 1, true).map((t) => t.id)).toEqual([1, 2, 3]);
  });
  it('相邻移动不产生重复', () => {
    expect(insertRelativeTo(abc, 1, 2, true).map((t) => t.id)).toEqual([1, 2, 3]);
  });
});

describe('Tag', () => {
  it('网格视图渲染卡片与计数', async () => {
    await boot([row(), row({ id: 2, name: '经典', sort: 2 })]);
    expect(screen.getByText('高清')).toBeTruthy();
    expect(screen.getByText('经典')).toBeTruthy();
    expect(screen.getAllByText('视频 0')).toHaveLength(2); // 两张卡片各一处
    expect(screen.getAllByText('演员 0')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '拖动排序 高清' })).toBeTruthy();
  });

  it('空库显示空态', async () => {
    await boot([]);
    expect(screen.getByText('还没有标签，添加第一个吧')).toBeTruthy();
  });

  it('添加：trim 提交并清空输入、刷新', async () => {
    await boot([]);
    mockedFetch.mockResolvedValue({ ok: true, items: [row({ id: 5, name: '4K' })] });
    mockedCreate.mockResolvedValue({ ok: true, item: row({ id: 5, name: '4K' }) });
    const input = screen.getByPlaceholderText('标签名（如：高清）');
    fireEvent.change(input, { target: { value: '  4K  ' } });
    fireEvent.click(screen.getByText('添加'));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith('4K'));
    await screen.findByText('4K');
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('添加失败（重名）显示服务端错误，输入保留', async () => {
    await boot([row()]);
    mockedCreate.mockRejectedValue(new Error('标签已存在'));
    const input = screen.getByPlaceholderText('标签名（如：高清）');
    fireEvent.change(input, { target: { value: '高清' } });
    fireEvent.click(screen.getByText('添加'));
    expect(await screen.findByText('标签已存在')).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('高清');
  });

  it('改名：hover 图标或点击名字进入编辑态（回填原名），Enter 提交', async () => {
    await boot([row(), row({ id: 2, name: '经典', sort: 2 })]);
    // 路径一：hover 图标按钮
    fireEvent.click(screen.getByRole('button', { name: '改名 高清' }));
    let edit = screen.getByDisplayValue('高清') as HTMLInputElement;
    fireEvent.keyDown(edit, { key: 'Escape' });
    // 路径二：点击卡片名字直接进入编辑
    fireEvent.click(screen.getByText('高清'));
    edit = screen.getByDisplayValue('高清') as HTMLInputElement;
    fireEvent.change(edit, { target: { value: '超清' } });
    mockedRename.mockResolvedValue({ ok: true, item: row({ name: '超清' }) });
    mockedFetch.mockResolvedValue({ ok: true, items: [row({ name: '超清' }), row({ id: 2, name: '经典', sort: 2 })] });
    fireEvent.keyDown(edit, { key: 'Enter' });
    await waitFor(() => expect(mockedRename).toHaveBeenCalledWith(1, '超清'));
    await screen.findByText('超清');
  });

  it('删除：ConfirmDialog 确认后调用接口', async () => {
    await boot([row()]);
    fireEvent.click(screen.getByRole('button', { name: '删除 高清' }));
    expect(screen.getByText('删除标签')).toBeTruthy();
    expect(screen.getByText(/「高清」/)).toBeTruthy();
    mockedDelete.mockResolvedValue({ ok: true });
    mockedFetch.mockResolvedValue({ ok: true, items: [] });
    fireEvent.click(screen.getAllByText('删除').at(-1)!);
    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith(1));
    await screen.findByText('还没有标签，添加第一个吧');
  });

  it('视图切换到行视图并持久化 localStorage；行视图渲染表格', async () => {
    await boot([row()]);
    fireEvent.click(screen.getByRole('button', { name: '行' }));
    expect(localStorage.getItem('tag-view')).toBe('row');
    expect(document.querySelector('table')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '网格' }));
    expect(localStorage.getItem('tag-view')).toBe('grid');
    expect(document.querySelector('table')).toBeNull();
  });

  it('初始视图读取 localStorage（row）', async () => {
    localStorage.setItem('tag-view', 'row');
    await boot([row()]);
    expect(document.querySelector('table')).toBeTruthy();
  });
});
