import { useEffect, useRef, useState, type FormEvent } from 'react';
import { archiveVideo, fetchRawFiles } from '@/lib/api';
import type { ActressRow, CountryRow, RawFileRow, StudioRow, TagRow } from '@/lib/types';
import { VideoPlayer } from '@/components/VideoPlayer';
import { RatingInput } from '@/components/RatingInput';
import { NATIVE_VIDEO_EXTS } from '@/utils/media';

interface Props {
  /** 待归档的视频 raw 行。 */
  file: RawFileRow;
  actresses: ActressRow[];
  countries: CountryRow[];
  tags: TagRow[];
  studios: StudioRow[];
  onClose: () => void;
  onDone: (msg: string) => void;
}

/** stem（name 列）小写——封面同名匹配键。 */
const stemKey = (name: string) => name.trim().toLowerCase();

/** 演员选择变化的重置语义：国家 = 第一位演员的国家；标签 = 所选演员标签并集（均可再手动改）。 */
function deriveFromActresses(selected: ActressRow[]): { countryId: number; tagIds: Set<number> } {
  const countryId = selected[0]?.country_id ?? 0;
  const tagIds = new Set<number>();
  for (const a of selected) for (const t of a.tags) tagIds.add(t.id);
  return { countryId, tagIds };
}

/** 基础分 = 所选演员最高评分（未评分按 0；未选为 0）。展示分 = min(100, 基础分 + 加分)。 */
function baseRatingOf(selected: ActressRow[]): number {
  return selected.reduce((m, a) => Math.max(m, a.rating ?? 0), 0);
}

/**
 * 视频归档弹窗：左播放区（原生格式直连；ts/avi 等走 hls.js）+ 右表单。
 * 单片流程完整可用；剧集切换仅占位（禁用确认，待后续迭代）。
 */
export function ArchiveDialog({ file, actresses, countries, tags, studios, onClose, onDone }: Props) {
  const [kind, setKind] = useState<'single' | 'series'>('single');
  // 标题预填视频文件名（name 列 = stem），可改
  const [title, setTitle] = useState(file.name);
  const [subtitle, setSubtitle] = useState('');
  const [code, setCode] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [selected, setSelected] = useState<ActressRow[]>([]);
  const [countryId, setCountryId] = useState(0);
  const [tagIds, setTagIds] = useState<Set<number>>(new Set());
  const [studioId, setStudioId] = useState(0);
  const [cover, setCover] = useState<RawFileRow | null>(null);
  const [coverResults, setCoverResults] = useState<RawFileRow[] | null>(null);
  const [coverQ, setCoverQ] = useState('');
  const [actressQ, setActressQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const dlgRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dlgRef.current;
    if (d && !d.open) d.showModal();
  }, []);

  // 封面自动匹配：同 stem 图片（同名判定），同目录优先、path 升序取第一
  useEffect(() => {
    let alive = true;
    const key = stemKey(file.name);
    fetchRawFiles({ page: 1, size: 50, q: file.name, type: 'image' })
      .then((d) => {
        if (!alive) return;
        const dir = file.path.slice(0, file.path.lastIndexOf('/'));
        const same = d.items.filter((it) => stemKey(it.name) === key);
        const pick =
          same.find((it) => it.path.startsWith(`${dir}/`)) ?? [...same].sort((a, b) => a.path.localeCompare(b.path))[0] ?? null;
        setCover(pick);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [file.id, file.name, file.path]);

  const toggleActress = (a: ActressRow) => {
    setSelected((prev) => {
      const next = prev.some((x) => x.id === a.id) ? prev.filter((x) => x.id !== a.id) : [...prev, a];
      const derived = deriveFromActresses(next);
      setCountryId(derived.countryId);
      setTagIds(derived.tagIds);
      // 加分上限随基础分变化（100 − 演员最高评分），超出即收拢
      const maxAdd = 100 - baseRatingOf(next);
      setRating((r) => (r != null && r > maxAdd ? maxAdd : r));
      return next;
    });
  };

  const toggleTag = (id: number) => {
    setTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const searchCover = async () => {
    const q = coverQ.trim();
    if (!q) return;
    setBusy(true);
    setErr('');
    try {
      const d = await fetchRawFiles({ page: 1, size: 24, q, type: 'image' });
      setCoverResults(d.items);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    const t = title.trim();
    if (!t) {
      setErr('标题不能为空');
      return;
    }
    if (!selected.length) {
      setErr('归档需要至少一位演员');
      return;
    }
    if (!countryId) {
      setErr('请选择国家');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await archiveVideo({
        fileId: file.id,
        coverFileId: cover?.id ?? null,
        title: t,
        subtitle: subtitle.trim() || undefined,
        code: code.trim() || undefined,
        rating,
        actressIds: selected.map((a) => a.id),
        countryId,
        tagIds: [...tagIds],
        studioId: studioId || undefined,
        kind: 'single',
      });
      onDone(`已归档「${[code.trim(), t, subtitle.trim()].filter(Boolean).join(' ')}」`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const needle = actressQ.trim().toLowerCase();
  const actressResults = actresses.filter(
    (a) => !needle || a.name.toLowerCase().includes(needle) || a.aliases.some((x) => x.toLowerCase().includes(needle)),
  );
  // 加分制：基础分 = 所选演员最高评分；最终评分 = min(100, 基础分 + 加分)
  const base = baseRatingOf(selected);
  const score = Math.min(100, base + (rating ?? 0));

  return (
    <dialog ref={dlgRef} onClose={onClose} closedby="any">
      <form onSubmit={submit} className="flex w-[min(1060px,94vw)] gap-4">
        {/* 左：播放区 */}
        <div className="flex w-[44%] shrink-0 flex-col">
          {/* 通用播放内核：原生格式直连优先（error 回退 hls 转码）；其余 hls.js 主路径 */}
          <VideoPlayer
            item={{
              path: file.path,
              direct: `/api/raw/file/${file.id}/content`,
              hls: `/api/raw/file/${file.id}/index.m3u8`,
              preferDirect: NATIVE_VIDEO_EXTS.has(file.ext),
            }}
            className="aspect-video w-full rounded-lg bg-black"
          />
          <div className="mt-2 truncate font-mono text-xs text-dim" title={file.path}>
            {file.path}
          </div>
        </div>

        {/* 右：表单区 */}
        <div className="flex min-w-0 flex-1 flex-col" aria-label="归档表单">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[15px] font-bold">归档视频</span>
            <span className="ml-auto flex gap-1" role="group" aria-label="类型">
              <button type="button" className={`act ${kind === 'single' ? 'act-primary' : ''}`} aria-pressed={kind === 'single'} onClick={() => setKind('single')}>
                单片
              </button>
              <button type="button" className={`act ${kind === 'series' ? 'act-primary' : ''}`} aria-pressed={kind === 'series'} onClick={() => setKind('series')}>
                剧集
              </button>
            </span>
          </div>

          {kind === 'series' ? (
            <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-line p-8 text-center text-dim">
              剧集归档待后续迭代——请先以单片归档，或关闭弹窗
            </div>
          ) : (
            <div className="max-h-[70vh] flex-1 overflow-y-auto pr-1">
              <div className="grid grid-cols-2 gap-2">
                <label className="col-span-2 block">
                  <span className="text-xs text-dim">标题（必填）</span>
                  <input className="mt-1 w-full" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} autoFocus />
                </label>
                <label className="block">
                  <span className="text-xs text-dim">副标题（可选）</span>
                  <input className="mt-1 w-full" value={subtitle} maxLength={120} onChange={(e) => setSubtitle(e.target.value)} />
                </label>
                <label className="block">
                  <span className="text-xs text-dim">番号（可选）</span>
                  <input className="mt-1 w-full" value={code} maxLength={60} onChange={(e) => setCode(e.target.value)} />
                </label>
                <div className="col-span-2">
                  <span className="text-xs text-dim">加分（可选，基础分 {base}，上限 {100 - base}）</span>
                  <div className="mt-1">
                    <RatingInput value={rating} onChange={setRating} max={100 - base} />
                  </div>
                  <div className="mt-1 text-xs">
                    最终评分：
                    <span className="font-mono font-bold">
                      {score}
                      <span className="ml-1 font-normal text-dim">
                        （基础分 {base}{rating != null ? ` + 加分 ${rating}` : '，未加分'}）
                      </span>
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-2 text-xs text-dim">演员（必选，第一位决定归档目录）</div>
              <input
                className="mt-1 w-full"
                placeholder="搜索女优（名字或别名）"
                value={actressQ}
                onChange={(e) => setActressQ(e.target.value)}
              />
              {selected.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {selected.map((a, i) => (
                    <span key={a.id} className="chip">
                      {i === 0 ? '📁 ' : ''}
                      {a.name}
                      <button type="button" className="ml-1 text-dim transition-colors hover:text-err" aria-label={`移除演员 ${a.name}`} onClick={() => toggleActress(a)}>
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="mt-1.5 max-h-28 overflow-y-auto rounded-lg">
                {actressResults.slice(0, 30).map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-raised ${selected.some((x) => x.id === a.id) ? 'opacity-50' : ''}`}
                    onClick={() => toggleActress(a)}
                  >
                    {a.avatar_file_id ? (
                      <img src={`/api/raw/file/${a.avatar_file_id}/content`} alt="" className="size-6 shrink-0 rounded-full object-cover" />
                    ) : (
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-raised text-[10px] text-dim">{a.name.slice(0, 1)}</span>
                    )}
                    <span className="truncate">{a.name}</span>
                    <span className="ml-auto shrink-0 text-xs text-dim">{a.country_name}</span>
                  </button>
                ))}
                {actresses.length === 0 ? <p className="px-2 py-3 text-xs text-err">没有女优——请先到女优页添加</p> : null}
              </div>

              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-xs text-dim">国家（选演员自动填充）</span>
                  <select className="mt-1 w-full" value={countryId} onChange={(e) => setCountryId(Number(e.target.value))}>
                    <option value={0}>（未选）</option>
                    {countries.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs text-dim">片商（可选）</span>
                  <select className="mt-1 w-full" value={studioId} onChange={(e) => setStudioId(Number(e.target.value))}>
                    <option value={0}>（无）</option>
                    {studios.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {tags.length > 0 ? (
                <>
                  <div className="mt-2 text-xs text-dim">标签（选演员自动填并集）</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {tags.map((t) => (
                      <button key={t.id} type="button" className={`chip ${tagIds.has(t.id) ? '' : 'opacity-60'}`} aria-pressed={tagIds.has(t.id)} onClick={() => toggleTag(t.id)}>
                        {t.name}
                      </button>
                    ))}
                  </div>
                </>
              ) : null}

              <div className="mt-3 text-xs text-dim">封面（同名图片自动匹配，可搜索替换/清空）</div>
              {cover ? (
                <div className="mt-1.5 flex items-center gap-2">
                  <img src={`/api/raw/file/${cover.id}/content`} alt="封面预览" className="h-16 rounded-md object-cover" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-dim" title={cover.path}>
                    {cover.path}
                  </span>
                  <button type="button" className="act shrink-0" onClick={() => setCover(null)}>
                    清空
                  </button>
                </div>
              ) : (
                <p className="mt-1 text-xs text-dim">（未选封面——只归档视频）</p>
              )}
              <div className="mt-1.5 flex gap-2">
                <input
                  className="min-w-0 flex-1"
                  placeholder="搜索图片替换封面"
                  value={coverQ}
                  onChange={(e) => setCoverQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void searchCover();
                    }
                  }}
                />
                <button type="button" className="act shrink-0" disabled={busy || !coverQ.trim()} onClick={() => void searchCover()}>
                  搜索
                </button>
              </div>
              {coverResults ? (
                <div className="mt-1.5 grid grid-cols-4 gap-1.5">
                  {coverResults.map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      className={`overflow-hidden rounded-md transition-[outline] ${cover?.id === it.id ? 'outline outline-2 outline-brand' : 'hover:opacity-80'}`}
                      title={it.path}
                      onClick={() => setCover(it)}
                    >
                      <img src={`/api/raw/file/${it.id}/content`} alt="" className="aspect-video w-full object-cover" />
                    </button>
                  ))}
                  {coverResults.length === 0 ? <p className="col-span-4 text-xs text-dim">没有匹配图片</p> : null}
                </div>
              ) : null}

              {err ? <p className="mt-2 text-xs text-err">{err}</p> : null}
            </div>
          )}

          <div className="mt-3 flex justify-end gap-2.5">
            <button type="button" className="act" onClick={() => dlgRef.current?.close()}>
              取消
            </button>
            <button type="submit" className="act act-primary" disabled={busy || kind !== 'single'}>
              {busy ? '归档中…' : '确认归档'}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}
