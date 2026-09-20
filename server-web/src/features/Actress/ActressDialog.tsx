import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CountryRow, ActressRow, ActressUpsertRequest, TagRow } from '@/lib/types';

interface Props {
  /** 编辑对象；null = 创建。 */
  init: ActressRow | null;
  countries: CountryRow[];
  tags: TagRow[];
  disks: string[];
  onSubmit: (payload: ActressUpsertRequest) => Promise<void>;
  onCancel: () => void;
}

/** 评分行：slider 0-100 + 未评分清除。 */
function RatingInput({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={value ?? 0}
        aria-label="评分"
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1"
      />
      <span className="w-16 shrink-0 text-right font-mono text-xs text-dim">
        {value == null ? '未评分' : `${value} / 100`}
      </span>
      <button
        type="button"
        className="act shrink-0"
        onClick={() => onChange(null)}
        disabled={value == null}
        title="清除评分"
      >
        清除
      </button>
    </div>
  );
}

/**
 * 女优创建/编辑表单弹窗：名字、国家（必选）、评分 slider、标签多选、磁盘单选（创建）、别名动态列表。
 * 提交调 onSubmit（父组件负责请求与关闭）。
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
  const dlgRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dlgRef.current;
    if (d && !d.open) d.showModal();
  }, []);

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
      await onSubmit(payload); // 父组件成功后卸载本组件（即关闭）
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <dialog ref={dlgRef} onClose={onCancel} closedby="any">
      <form onSubmit={submit} className="w-[min(560px,90vw)]">
        <div className="mb-3 text-[15px] font-bold">{editing ? `编辑女优 · ${init!.name}` : '添加女优'}</div>

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
      </form>
    </dialog>
  );
}
