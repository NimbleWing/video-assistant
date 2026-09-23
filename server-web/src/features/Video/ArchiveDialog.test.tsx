import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveVideo, fetchRawFiles } from '@/lib/api';
import type { ActressRow, CountryRow, RawFileRow, StudioRow, TagRow } from '@/lib/types';
import { ArchiveDialog } from './ArchiveDialog';

vi.mock('@/lib/api', () => ({
  archiveVideo: vi.fn(),
  fetchRawFiles: vi.fn(),
}));
const mockedArchive = vi.mocked(archiveVideo);
const mockedFetchRaw = vi.mocked(fetchRawFiles);
// hls.js 打桩（播放区建链不进测试关注点）
vi.mock('hls.js', () => ({ default: { isSupported: () => false } }));

const actresses: ActressRow[] = [
  {
    id: 1, name: '甲女优', country_id: 1, country_name: '日本', rating: null, disk: 'd:', avatar_file_id: null,
    aliases: [], tags: [{ id: 11, name: '高清', sort: 1 }], video_count: 0,
  },
  {
    id: 2, name: '乙女优', country_id: 2, country_name: '美国', rating: null, disk: 'e:', avatar_file_id: null,
    aliases: [], tags: [{ id: 12, name: '经典', sort: 2 }], video_count: 0,
  },
];
const countries: CountryRow[] = [{ id: 1, name: '日本' }, { id: 2, name: '美国' }];
const tags: TagRow[] = [
  { id: 11, name: '高清', sort: 1, video_count: 0, actor_count: 0 },
  { id: 12, name: '经典', sort: 2, video_count: 0, actor_count: 0 },
];
const studios: StudioRow[] = [{ id: 21, name: '某片商', has_logo: false, video_count: 0, actor_count: 0 }];

const file: RawFileRow = {
  id: 99, path: 'c:/rawfiles/clip.mp4', hash: 'h', name: 'clip', ext: 'mp4', type: 'video',
  size: 100, mtime: 1, volume: 'c:', missing: false, pending_missing: false, archived: false,
  duration: null, first_seen: 1, last_seen: 1,
};

function boot() {
  render(
    <ArchiveDialog
      file={file}
      actresses={actresses}
      countries={countries}
      tags={tags}
      studios={studios}
      onClose={() => {}}
      onDone={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetchRaw.mockResolvedValue({ ok: true, total: 0, items: [], volumes: [] });
});

describe('ArchiveDialog', () => {
  it('标题自动预填视频文件名（stem），可改', async () => {
    boot();
    const titleInput = (await screen.findByLabelText(/标题（必填）/)) as HTMLInputElement;
    expect(titleInput.value).toBe('clip');
    fireEvent.change(titleInput, { target: { value: '改名了' } });
    expect(titleInput.value).toBe('改名了');
  });

  it('封面自动匹配：同 stem 图片（同目录优先）被预选', async () => {
    mockedFetchRaw.mockResolvedValue({
      ok: true, total: 2, volumes: [],
      items: [
        { ...file, id: 50, path: 'e:/other/clip.jpg', name: 'clip', ext: 'jpg', type: 'image' },
        { ...file, id: 51, path: 'c:/rawfiles/clip.jpg', name: 'clip', ext: 'jpg', type: 'image' },
      ],
    });
    boot();
    await waitFor(() => expect(mockedFetchRaw).toHaveBeenCalledWith(expect.objectContaining({ type: 'image' })));
    const img = await screen.findByAltText('封面预览');
    expect((img as HTMLImageElement).src).toContain('/api/raw/file/51/content'); // 同目录优先
    expect(screen.getByTitle('c:/rawfiles/clip.jpg')).toBeTruthy();
  });

  it('选演员：自动填充第一位演员国家 + 标签并集；提交完整 payload', async () => {
    boot();
    fireEvent.click(await screen.findByText('甲女优'));
    expect((screen.getByLabelText(/国家（选演员自动填充）/) as HTMLSelectElement).value).toBe('1');
    expect(screen.getByRole('button', { name: '高清' }).getAttribute('aria-pressed')).toBe('true'); // 并集预选
    fireEvent.click(screen.getByText('乙女优'));
    expect((screen.getByLabelText(/国家（选演员自动填充）/) as HTMLSelectElement).value).toBe('1'); // 仍是第一位（甲）的国家
    expect(screen.getByRole('button', { name: '经典' }).getAttribute('aria-pressed')).toBe('true'); // 并集
    fireEvent.change(screen.getByLabelText(/标题（必填）/), { target: { value: '作品名' } });
    fireEvent.change(screen.getByLabelText(/番号（可选）/), { target: { value: 'ABC-1' } });
    fireEvent.change(screen.getByLabelText(/片商（可选）/, { selector: 'select' }), { target: { value: '21' } });
    mockedArchive.mockResolvedValue({ ok: true, item: {} as never });
    fireEvent.click(screen.getByText('确认归档'));
    await waitFor(() =>
      expect(mockedArchive).toHaveBeenCalledWith({
        fileId: 99,
        coverFileId: null,
        title: '作品名',
        subtitle: undefined,
        code: 'ABC-1',
        actressIds: [1, 2],
        countryId: 1,
        tagIds: expect.arrayContaining([11, 12]),
        studioId: 21,
        kind: 'single',
      }),
    );
  });

  it('无标题/无演员提交被拦截并提示', async () => {
    boot();
    const titleInput = await screen.findByLabelText(/标题（必填）/);
    fireEvent.change(titleInput, { target: { value: '' } }); // 清空预填的文件名
    fireEvent.click(screen.getByText('确认归档'));
    expect(await screen.findByText('标题不能为空')).toBeTruthy();
    expect(mockedArchive).not.toHaveBeenCalled();
    fireEvent.change(titleInput, { target: { value: 'x' } });
    fireEvent.click(screen.getByText('确认归档'));
    expect(await screen.findByText('归档需要至少一位演员')).toBeTruthy();
    expect(mockedArchive).not.toHaveBeenCalled();
  });

  it('剧集切换：显示占位提示且确认禁用', async () => {
    boot();
    fireEvent.click(screen.getByRole('button', { name: '剧集' }));
    expect(await screen.findByText(/剧集归档待后续迭代/)).toBeTruthy();
    expect((screen.getByText('确认归档') as HTMLButtonElement).disabled).toBe(true);
  });

  it('封面可清空；可搜索替换（结果点击选中）', async () => {
    mockedFetchRaw.mockResolvedValue({
      ok: true, total: 1, volumes: [],
      items: [{ ...file, id: 51, path: 'c:/rawfiles/clip.jpg', name: 'clip', ext: 'jpg', type: 'image' }],
    });
    boot();
    await screen.findByAltText('封面预览');
    fireEvent.click(screen.getByText('清空'));
    expect(screen.getByText('（未选封面——只归档视频）')).toBeTruthy();
    // 搜索替换
    mockedFetchRaw.mockResolvedValue({
      ok: true, total: 1, volumes: [],
      items: [{ ...file, id: 77, path: 'e:/pic/pick.jpg', name: 'pick', ext: 'jpg', type: 'image' }],
    });
    fireEvent.change(screen.getByPlaceholderText('搜索图片替换封面'), { target: { value: 'pick' } });
    fireEvent.click(screen.getByText('搜索'));
    const pick = await screen.findByTitle('e:/pic/pick.jpg');
    fireEvent.click(pick);
    expect((screen.getByAltText('封面预览') as HTMLImageElement).src).toContain('/api/raw/file/77/content');
  });
});
