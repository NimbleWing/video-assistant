import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActress, deleteActress, fetchActressDisks, fetchActresses, setActressAvatar, updateActress } from '@/lib/api';
import type { ActressRow, CountryRow, TagRow } from '@/lib/types';
import { Actress } from './Actress';
import { AvatarPicker } from './AvatarPicker';

vi.mock('@/lib/api', () => ({
  fetchActresses: vi.fn(),
  fetchActressDisks: vi.fn(),
  createActress: vi.fn(),
  updateActress: vi.fn(),
  deleteActress: vi.fn(),
  setActressAvatar: vi.fn(),
}));
const mockedList = vi.mocked(fetchActresses);
const mockedDisks = vi.mocked(fetchActressDisks);
const mockedCreate = vi.mocked(createActress);
const mockedUpdate = vi.mocked(updateActress);
const mockedDelete = vi.mocked(deleteActress);
const mockedSetAvatar = vi.mocked(setActressAvatar);

const countries: CountryRow[] = [{ id: 1, name: '日本' }, { id: 2, name: '美国' }];
const tags: TagRow[] = [
  { id: 11, name: '高清', sort: 1, video_count: 0, actor_count: 0 },
  { id: 12, name: '经典', sort: 2, video_count: 0, actor_count: 0 },
];

function row(partial: Partial<ActressRow> = {}): ActressRow {
  return {
    id: 1,
    name: '樱空桃',
    country_id: 1,
    country_name: '日本',
    rating: 87,
    disk: 'd:',
    avatar_file_id: null,
    aliases: [],
    tags: [],
    video_count: 0,
    ...partial,
  };
}

/** Actress 页渲染（countries/tags 经全局 fetch stub 提供；api mock 提供 actresses/disks）。 */
async function boot(items: ActressRow[], disks = ['c:', 'd:']) {
  mockedList.mockResolvedValue({ ok: true, items });
  mockedDisks.mockResolvedValue({ ok: true, disks });
  render(<Actress />);
  if (items.length) await screen.findByText(items[0]!.name);
  else await screen.findByText('还没有女优，添加第一位吧');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    json: async () => (String(url).includes('countries') ? { items: countries } : { items: tags }),
  })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Actress 页', () => {
  it('卡片渲染：头像 img / 首字占位、国家·评分、标签 chips、别名预览、视频计数', async () => {
    await boot([
      row(),
      row({ id: 2, name: '深田えいみ', country_id: 2, country_name: '美国', rating: null, avatar_file_id: 33, aliases: ['Fukada'], tags: [{ id: 11, name: '高清', sort: 1 }] }),
    ]);
    expect(screen.queryByAltText('樱空桃 头像')).toBeNull(); // 无头像 → 占位
    expect(screen.getByText('樱')).toBeTruthy();
    const img = screen.getByAltText('深田えいみ 头像') as HTMLImageElement;
    expect(img.src).toContain('/api/raw/file/33/content');
    expect(screen.getByText('日本')).toBeTruthy();
    expect(screen.getByText('87')).toBeTruthy();
    expect(screen.getByText('未评分')).toBeTruthy();
    expect(screen.getByText('高清')).toBeTruthy();
    expect(screen.getByText('Fukada')).toBeTruthy();
    expect(screen.getAllByText('视频 0')).toHaveLength(2);
  });

  it('空库显示空态', async () => {
    await boot([]);
    expect(screen.getByText('还没有女优，添加第一位吧')).toBeTruthy();
  });

  it('搜索防抖 300ms 后带 q 重新拉取', async () => {
    await boot([row()]);
    mockedList.mockClear();
    fireEvent.change(screen.getByPlaceholderText('搜索女优（名字或别名）'), { target: { value: '桃' } });
    await waitFor(() => expect(mockedList).toHaveBeenCalledWith('桃'), { timeout: 1500 });
  });

  it('添加：dialog 表单（国家/评分/标签/磁盘/别名）提交完整 payload', async () => {
    await boot([]);
    fireEvent.click(screen.getByText('添加女优'));
    const dlg = await screen.findByRole('dialog');
    expect(dlg).toBeTruthy();
    fireEvent.change(screen.getByLabelText('名字'), { target: { value: '新女优' } });
    fireEvent.change(screen.getByLabelText('评分'), { target: { value: '66' } });
    fireEvent.click(screen.getByText('日本')); // 国家
    fireEvent.click(screen.getByText('高清')); // 标签
    fireEvent.click(screen.getByText('d:')); // 磁盘
    // 别名：输入回车
    const aliasInput = screen.getByPlaceholderText('输入别名后回车/添加');
    fireEvent.change(aliasInput, { target: { value: '别名A' } });
    fireEvent.keyDown(aliasInput, { key: 'Enter' });
    expect(screen.getByText('别名A')).toBeTruthy();
    mockedCreate.mockResolvedValue({ ok: true, item: row({ id: 9, name: '新女优' }) });
    fireEvent.click(screen.getByText('创建'));
    await waitFor(() =>
      expect(mockedCreate).toHaveBeenCalledWith({
        name: '新女优',
        countryId: 1,
        rating: 66,
        tagIds: [11],
        aliases: ['别名A'],
        disk: 'd:',
      }),
    );
  });

  it('编辑：点卡片名字打开 dialog 回显，保存调 updateActress', async () => {
    await boot([row({ tags: [{ id: 12, name: '经典', sort: 2 }] })]);
    fireEvent.click(screen.getByText('樱空桃'));
    expect(await screen.findByText('编辑女优 · 樱空桃')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('名字'), { target: { value: '樱空桃改' } });
    mockedUpdate.mockResolvedValue({ ok: true, item: row({ name: '樱空桃改' }) });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(mockedUpdate).toHaveBeenCalledWith(1, expect.objectContaining({ name: '樱空桃改', countryId: 1 })));
  });

  it('删除：ConfirmDialog 注明关联清除与头像保留，确认后调接口', async () => {
    await boot([row()]);
    fireEvent.click(screen.getByRole('button', { name: '删除 樱空桃' }));
    expect(screen.getByText('删除女优')).toBeTruthy();
    expect(screen.getByText(/头像文件保留在图集目录/)).toBeTruthy();
    mockedDelete.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getAllByText('删除').at(-1)!);
    await waitFor(() => expect(mockedDelete).toHaveBeenCalledWith(1));
  });
});

describe('AvatarPicker（设为头像弹窗）', () => {
  it('列出女优（头像缩略/首字、国家），点选即调 setActressAvatar', async () => {
    const list = [row(), row({ id: 2, name: '别人', aliases: ['X'] })];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ items: list }) })));
    const onDone = vi.fn();
    const file = { id: 55, path: 'd:/rawfiles/pic.jpg' } as unknown as Parameters<typeof AvatarPicker>[0]['file'];
    render(<AvatarPicker file={file} onClose={() => {}} onDone={onDone} />);
    fireEvent.click(await screen.findByText('樱空桃'));
    mockedSetAvatar.mockResolvedValue({ ok: true, item: row() });
    await waitFor(() => expect(mockedSetAvatar).toHaveBeenCalledWith(1, 55));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.stringContaining('樱空桃')));
  });
});
