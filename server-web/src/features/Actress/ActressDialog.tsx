import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CountryRow, ActressRow, ActressUpsertRequest, RawFileRow, TagRow } from '@/lib/types';
import { fetchRawFiles } from '@/lib/api';
import { RatingInput } from '@/components/RatingInput';

interface Props {
  /** 编辑对象；null = 创建。 */
  init: ActressRow | null;
  countries: CountryRow[];
  tags: TagRow[];
  disks: string[];
  /** 第二参 avatarFileId：创建模式选了头像图片时回传，父组件负责创建后链式设头像。 */
  onSubmit: (payload: ActressUpsertRequest, avatarFileId?: number) => Promise<void>;
  onCancel: () => void;
}

/**
 * 女优创建/编辑表单弹窗：名字、国家（必选）、评分 slider、标签多选、磁盘单选（创建）、别名动态列表。
 * 提交调 onSubmit（父组件负责请求与关闭）。
 * 创建模式为左右两栏：左栏头像区——搜索本地 raw 图片库（关键词默认跟随名字），点选缩略图后上方大图预览。
 */
export function ActressDialog({ init, countries, tags, disks, onSubmit, onCancel }: Props) {
  const editing = init != null;
  const [name, setName] = useState(init?.name ?? '');
  const [countryId, setCountryId] = useState<number>(init?.country_id ?? (countries[0]?.id ?? 0));
  const [rating, setRating] = useState<number | null>(init?.rating ?? null);
  const [tagIds, setTagIds] = useState<Set<number>>(new Set(init?.tags.map((t) => t.id) ?? []));
  const [disk, setDisk] = useState<string>(init?.disk ?? (disks[0] ?? ''));
  const [aliases, setAliases] = useState<string[]>(init?.aliases ?? []);
  const [aliasDraft, setAliasDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [avatarQ, setAvatarQ] = useState('');
  const [avatarItems, setAvatarItems] = useState<RawFileRow[] | null>(null);
  const [avatarSel, setAvatarSel] = useState<RawFileRow | null>(null);
  /** 用户手动改过头像搜索框后，关键词不再跟随名字。 */
  const avatarQTouched = useRef(false);
  const dlgRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dlgRef.current;
    if (d && !d.open) d.showModal();
  }, []);

  // 头像搜索关键词默认跟随名字输入
  useEffect(() => {
    if (editing || avatarQTouched.current) return;
    setAvatarQ(name.trim());
  }, [name, editing]);

  // 头像图片搜索：本地 raw 图片库（未归档），防抖 300ms
  useEffect(() => {
    if (editing) return;
    let alive = true;
    const t = setTimeout(() => {
      fetchRawFiles({ page: 1, size: 24, q: avatarQ.trim() || undefined, type: 'image' })
        .then((d) => {
          if (alive) setAvatarItems(d.items);
        })
        .catch(() => {
          if (alive) setAvatarItems([]);
        });
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [avatarQ, editing]);

  const toggleTag = (id: number) => {
    setTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const addAlias = () => {
    const a = aliasDraft.trim();
    if (!a || aliases.includes(a)) {
      setAliasDraft('');
      return;
    }
    setAliases((prev) => [...prev, a]);
    setAliasDraft('');
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    const n = name.trim();
    if (!n) {
      setErr('女优名不能为空');
      return;
    }
    if (!countryId) {
      setErr('请先到国家页添加国家再创建女优');
      return;
    }
    if (!editing && !disk) {
      setErr('未探测到可用磁盘');
      return;
    }
    setBusy(true);
    setErr('');
    const payload: ActressUpsertRequest = {
      name: n,
      countryId,
      rating,
      tagIds: [...tagIds],
      aliases,
      ...(editing ? {} : { disk }),
    };
    try {
      await onSubmit(payload, editing ? undefined : avatarSel?.id); // 父组件成功后卸载本组件（即关闭）
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <dialog ref={dlgRef} onClose={onCancel} closedby="any">
      <form onSubmit={submit} className={editing ? 'w-[min(560px,90vw)]' : 'w-[min(920px,95vw)]'}>
        <div className="mb-3 text-[15px] font-bold">{editing ? `编辑女优 · ${init!.name}` : '添加女优'}</div>

        <div className={editing ? undefined : 'flex gap-5'}>
          {!editing ? (
            <div className="flex w-60 shrink-0 flex-col">
              <div className="aspect-square w-full overflow-hidden rounded-xl border border-line bg-raised">
                {avatarSel ? (
                  <img src={`/api/raw/file/${avatarSel.id}/content`} alt="头像预览" className="size-full object-cover" />
                ) : (
                  <div className="flex size-full items-center justify-center text-xs text-dim">未选择头像</div>
                )}
              </div>
              <input
                className="mt-2 w-full"
                placeholder="搜索图片（默认跟随名字）"
                aria-label="搜索头像图片"
                value={avatarQ}
                onChange={(e) => {
                  avatarQTouched.current = true;
                  setAvatarQ(e.target.value);
                }}
              />
              <div className="mt-2 grid max-h-56 grid-cols-3 content-start gap-1.5 overflow-y-auto">
                {avatarItems == null ? (
                  <p className="col-span-3 py-4 text-center text-xs text-dim">加载中…</p>
                ) : avatarItems.length === 0 ? (
                  <p className="col-span-3 py-4 text-center text-xs text-dim">没有匹配的图片</p>
                ) : (
                  avatarItems.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      title={f.path}
                      aria-label={`选择图片 ${f.name}`}
                      className={`aspect-square overflow-hidden rounded-lg border ${
                        avatarSel?.id === f.id ? 'border-brand ring-2 ring-brand' : 'border-line'
                      }`}
                      onClick={() => setAvatarSel((prev) => (prev?.id === f.id ? null : f))}
                    >
                      <img src={`/api/raw/file/${f.id}/content`} alt="" loading="lazy" className="size-full object-cover" />
                    </button>
                  ))
                )}
              </div>
              <p className="mt-1.5 text-[11px] text-dim">点选缩略图设为头像（再点取消）；创建成功后图片归档为 head.扩展名</p>
            </div>
          ) : null}

          <div className="min-w-0 flex-1">
        <label className="block text-xs text-dim" htmlFor="actress-name">
          名字
        </label>
        <input id="actress-name" className="mt-1 w-full" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoFocus />

        <label className="mt-3 block text-xs text-dim" htmlFor="actress-country">
          国家（必选——目录结构依赖）
        </label>
        <select
          id="actress-country"
          className="mt-1 w-full"
          value={countryId}
          onChange={(e) => setCountryId(Number(e.target.value))}
        >
          {countries.length === 0 ? <option value={0}>（请先到国家页添加国家）</option> : null}
          {countries.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        <div className="mt-3 text-xs text-dim">评分（百分制，可不评）</div>
        <div className="mt-1">
          <RatingInput value={rating} onChange={setRating} />
        </div>

        {tags.length > 0 ? (
          <>
            <div className="mt-3 text-xs text-dim">标签（多选）</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`chip ${tagIds.has(t.id) ? '' : 'opacity-60'}`}
                  aria-pressed={tagIds.has(t.id)}
                  onClick={() => toggleTag(t.id)}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </>
        ) : null}

        {!editing ? (
          <>
            <div className="mt-3 text-xs text-dim">磁盘（在根目录创建 Archives/国家/女优/图集）</div>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {disks.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`chip ${disk === d ? '' : 'opacity-60'}`}
                  aria-pressed={disk === d}
                  onClick={() => setDisk(d)}
                >
                  {d}
                </button>
              ))}
              {disks.length === 0 ? <span className="text-xs text-err">未探测到可用磁盘</span> : null}
            </div>
          </>
        ) : null}

        <div className="mt-3 text-xs text-dim">别名（可多个）</div>
        <div className="mt-1.5 flex items-center gap-2">
          <input
            className="flex-1"
            value={aliasDraft}
            maxLength={60}
            placeholder="输入别名后回车/添加"
            onChange={(e) => setAliasDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addAlias();
              }
            }}
          />
          <button type="button" className="act shrink-0" onClick={addAlias} disabled={!aliasDraft.trim()}>
            添加
          </button>
        </div>
        {aliases.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {aliases.map((a) => (
              <span key={a} className="chip">
                {a}
                <button
                  type="button"
                  className="ml-1 text-dim transition-colors hover:text-err"
                  aria-label={`删除别名 ${a}`}
                  onClick={() => setAliases((prev) => prev.filter((x) => x !== a))}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {err ? <p className="mt-3 text-xs text-err">{err}</p> : null}

        <div className="mt-4 flex justify-end gap-2.5">
          <button type="button" className="act" onClick={() => dlgRef.current?.close()}>
            取消
          </button>
          <button type="submit" className="act act-primary" disabled={busy}>
            {editing ? '保存' : '创建'}
          </button>
        </div>
          </div>
        </div>
      </form>
    </dialog>
  );
}
