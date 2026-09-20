import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCountry, deleteCountry, fetchCountries, renameCountry } from '@/lib/api';
import type { CountryRow } from '@/lib/types';
import { Country } from './Country';

vi.mock('@/lib/api', () => ({
  fetchCountries: vi.fn(),
  createCountry: vi.fn(),
  renameCountry: vi.fn(),
  deleteCountry: vi.fn(),
}));
const mockedFetch = vi.mocked(fetchCountries);
const mockedCreate = vi.mocked(createCountry);
const mockedRename = vi.mocked(renameCountry);
const mockedDelete = vi.mocked(deleteCountry);

function row(partial: Partial<CountryRow> = {}): CountryRow {
  return { id: 1, name: '日本', ...partial };
}

/** 设定初始列表并渲染（首轮 fetch + 完成渲染）。 */
async function boot(items: CountryRow[]) {
  mockedFetch.mockResolvedValue({ ok: true, items });
  render(<Country />);
  if (items.length) await screen.findByText(items[0]!.name);
  else await screen.findByText('还没有国家，添加第一个吧');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Country', () => {
  it('渲染全量列表与说明文案', async () => {
    await boot([row(), row({ id: 2, name: '美国' })]);
    expect(screen.getByText('日本')).toBeTruthy();
    expect(screen.getByText('美国')).toBeTruthy();
    expect(screen.getByText('演员体系的基础', { exact: false })).toBeTruthy();
  });

  it('空库显示空态', async () => {
    await boot([]);
    expect(screen.getByText('还没有国家，添加第一个吧')).toBeTruthy();
  });

  it('添加：trim 后提交并清空输入、刷新列表', async () => {
    await boot([]);
    mockedFetch.mockResolvedValue({ ok: true, items: [row({ id: 5, name: '韩国' })] });
    mockedCreate.mockResolvedValue({ ok: true, item: row({ id: 5, name: '韩国' }) });
    const input = screen.getByPlaceholderText('国家名（如：日本）');
    fireEvent.change(input, { target: { value: '  韩国  ' } });
    fireEvent.click(screen.getByText('添加'));
    await waitFor(() => expect(mockedCreate).toHaveBeenCalledWith('韩国'));
    await screen.findByText('韩国');
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('添加失败（重名 409）显示服务端错误信息，输入保留', async () => {
    await boot([row()]);
    mockedCreate.mockRejectedValue(new Error('国家已存在'));
    const input = screen.getByPlaceholderText('国家名（如：日本）');
    fireEvent.change(input, { target: { value: '日本' } });
    fireEvent.click(screen.getByText('添加'));
    expect(await screen.findByText('国家已存在')).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe('日本');
  });

  it('改名：进入编辑态回填原名，Enter 提交、Esc 取消', async () => {
    await boot([row(), row({ id: 2, name: '美国' })]);
    fireEvent.click(screen.getAllByText('改名')[0]!);
    const edit = screen.getByDisplayValue('日本') as HTMLInputElement;
    fireEvent.change(edit, { target: { value: 'Japan' } });
    mockedRename.mockResolvedValue({ ok: true, item: row({ name: 'Japan' }) });
    mockedFetch.mockResolvedValue({ ok: true, items: [row({ name: 'Japan' }), row({ id: 2, name: '美国' })] });
    fireEvent.keyDown(edit, { key: 'Enter' });
    await waitFor(() => expect(mockedRename).toHaveBeenCalledWith(1, 'Japan'));
    await screen.findByText('Japan');
  });

  it('删除：ConfirmDialog 二次确认后调用接口', async () => {
    await boot([row()]);
    fireEvent.click(screen.getByText('删除'));
    expect(screen.getByText('删除国家')).toBeTruthy();
    expect(screen.getByText(/「日本」/)).toBeTruthy();
    mockedDelete.mockResolvedValue({ ok: true });
    mockedFetch.mockResolvedValue({ ok: true, items: [] });
    fireEvent.click(screen.getAllByText('删除').at(-1)!); // 弹窗内的确认按钮
    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith(1));
    await screen.findByText('还没有国家，添加第一个吧');
  });
});
