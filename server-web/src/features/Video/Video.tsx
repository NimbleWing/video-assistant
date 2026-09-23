import { useEffect, useState } from 'react';
import { fetchActresses, fetchStudios, fetchTags, fetchWorks, setVideoRating } from '@/lib/api';
import type { PlaySource } from '@/components/PlayerDialog';
import type { ViewImage } from '@/components/ImageViewer';
import { NATIVE_VIDEO_EXTS } from '@/utils/media';
import { Pager } from '@/components/Pager';
import type { ActressesResponse, StudiosResponse, TagsResponse, VideoRow, WorksResponse } from '@/lib/types';
import { VideoCard } from './VideoCard';

const DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE_OPTIONS = [20, 50, 100];

interface Props {
  onStat: (text: string) => void;
  onPlay: (src: PlaySource) => void;
  /** 封面看大图（App 层 ImageViewer）。 */
  onView: (items: ViewImage[], index: number) => void;
}

/** 视频库页：作品域 kind=single 卡片浏览（搜索 + 演员/标签/片商筛选 + 播放探活 + 评分修改）。 */
export function Video({ onStat, onPlay, onView }: Props) {
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [actressId, setActressId] = useState(0);
  const [tagId, setTagId] = useState(0);
  const [studioId, setStudioId] = useState(0);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(DEFAULT_PAGE_SIZE);
  const [data, setData] = useState<WorksResponse | null>(null);
  const [error, setError] = useState('');
  const [playError, setPlayError] = useState('');
  const [dicts, setDicts] = useState<{
    actresses: ActressesResponse['items'];
    tags: TagsResponse['items'];
    studios: StudiosResponse['items'];
  }>({ actresses: [], tags: [], studios: [] });

  // 筛选字典一次性拉取（失败静默：筛选不可用不阻断列表）
  useEffect(() => {
    let alive = true;
    Promise.all([fetchActresses(), fetchTags(), fetchStudios()])
      .then(([a, t, s]) => {
        if (alive) setDicts({ actresses: a.items, tags: t.items, studios: s.items });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // 搜索防抖 300ms
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(qInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [qInput]);

  useEffect(() => {
    let alive = true;
    fetchWorks({
      page,
      size,
      q,
      kind: 'single',
      actressId: actressId || undefined,
      tagId: tagId || undefined,
      studioId: studioId || undefined,
    })
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError('');
        onStat(`单片 ${d.total}`);
      })
      .catch((e: unknown) => {
        if (alive) setError(String((e as Error)?.message || e));
      });
    return () => {
      alive = false;
    };
  }, [page, size, q, actressId, tagId, studioId, onStat]);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / size));

  /** 播放探活：先 HEAD 内容端点（文件缺失 404），失败给横幅——行状态过期（Archives 树不受扫描覆盖，手动删/移文件库不知情）。 */
  const play = async (it: VideoRow) => {
    const vf = it.video_file;
    if (!vf) {
      setPlayError(`文件记录缺失（库可能被手工改动）：${it.title}`);
      return;
    }
    try {
      const r = await fetch(`/api/raw/file/${vf.id}/content`, { method: 'HEAD' });
      if (!r.ok) throw new Error(String(r.status));
      setPlayError('');
      onPlay({
        path: vf.path,
        direct: `/api/raw/file/${vf.id}/content`,
        hls: `/api/raw/file/${vf.id}/index.m3u8`,
        preferDirect: NATIVE_VIDEO_EXTS.has(vf.ext),
      });
    } catch {
      setPlayError(`文件无法访问或已丢失：${vf.path}`);
    }
  };

  /** 封面看大图：仅当前条目（与 Raw 页同走 App 层 ImageViewer）。 */
  const view = (it: VideoRow) => {
    if (it.cover_file_id == null) return;
    onView([{ src: `/api/raw/file/${it.cover_file_id}/content`, alt: it.title }], 0);
  };

  /** 评分修改：落库后以响应行就地替换（保持筛选/分页不重拉）。 */
  const rate = async (it: VideoRow, rating: number | null) => {
    try {
      const r = await setVideoRating(it.id, rating);
      setData((d) => (d ? { ...d, items: d.items.map((x) => (x.id === it.id ? r.item : x)) } : d));
    } catch (e) {
      setPlayError(`评分失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="mb-4 flex shrink-0 flex-wrap items-center gap-2.5">
        <input
          type="search"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          placeholder="搜索标题 / 副标题 / 番号"
          aria-label="搜索视频库"
        />
        <select
          value={actressId}
          onChange={(e) => {
            setActressId(Number(e.target.value));
            setPage(1);
          }}
          aria-label="演员筛选"
        >
          <option value={0}>全部演员</option>
          {dicts.actresses.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <select
          value={tagId}
          onChange={(e) => {
            setTagId(Number(e.target.value));
            setPage(1);
          }}
          aria-label="标签筛选"
        >
          <option value={0}>全部标签</option>
          {dicts.tags.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select
          value={studioId}
          onChange={(e) => {
            setStudioId(Number(e.target.value));
            setPage(1);
          }}
          aria-label="片商筛选"
        >
          <option value={0}>全部片商</option>
          {dicts.studios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      {playError ? (
        <div className="mb-3 flex shrink-0 items-center gap-2 rounded-xl border border-err/40 bg-err-soft px-3.5 py-2.5 text-[13px] text-err">
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{playError}</span>
          <button type="button" className="act shrink-0" aria-label="关闭提示" onClick={() => setPlayError('')}>
            ✕
          </button>
        </div>
      ) : null}
      {error ? (
        <div className="shrink-0 rounded-xl border border-dashed border-line py-14 text-center text-dim">加载失败：{error}</div>
      ) : items.length === 0 ? (
        <div className="shrink-0 rounded-xl border border-dashed border-line py-14 text-center text-dim">
          {total === 0 && !q && !actressId && !tagId && !studioId
            ? '暂无归档作品（原始资料页视频卡片「归档」后进入视频库）'
            : '没有匹配的作品'}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
            {items.map((it) => (
              <VideoCard key={it.id} it={it} onPlay={play} onView={view} onRate={(v, r) => void rate(v, r)} />
            ))}
          </div>
        </div>
      )}
      <Pager
        page={page}
        pages={pages}
        total={total}
        onPrev={() => setPage((p) => p - 1)}
        onNext={() => setPage((p) => p + 1)}
        onJump={setPage}
        size={size}
        sizeOptions={PAGE_SIZE_OPTIONS}
        onSizeChange={(n) => {
          setSize(n);
          setPage(1);
        }}
      />
    </section>
  );
}
