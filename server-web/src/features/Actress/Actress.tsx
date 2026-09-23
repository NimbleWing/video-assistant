import { useEffect, useState } from 'react';
import { createActress, deleteActress, fetchActressDisks, fetchActresses, updateActress } from '@/lib/api';
import type { ActressRow, ActressUpsertRequest, CountryRow, TagRow } from '@/lib/types';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { TrashButton } from '@/components/RawCard';
import { ActressDialog } from './ActressDialog';

/**
 * 女优页面（演员体系核心，仅网格视图）：
 * 卡片 = 头像（avatar_file_id → /api/raw/file/:id/content，无则首字占位）+ 名字（点击编辑）
 * + 国家/评分 + 标签 chips（前 2 + N）+ 别名灰字 + 视频 N（预留）+ hover ✎ 编辑 / 🗑 删除。
 * 顶部搜索（防抖 300ms，匹配主名+别名）+ 添加按钮（dialog 表单）。
 */
export function Actress() {
  const [items, setItems] = useState<ActressRow[] | null>(null);
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [countries, setCountries] = useState<CountryRow[]>([]);
  const [tags, setTags] = useState<TagRow[]>([]);
  const [disks, setDisks] = useState<string[]>([]);
  const [editing, setEditing] = useState<'create' | ActressRow | null>(null);
  const [removing, setRemoving] = useState<ActressRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const refresh = (query = q) => {
    fetchActresses(query)
      .then((d) => setItems(d.items))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    refresh('');
    fetch('/api/countries')
      .then((r) => r.json())
      .then((j: { items?: CountryRow[] }) => setCountries(Array.isArray(j.items) ? j.items : []))
      .catch(() => {});
    fetch('/api/tags')
      .then((r) => r.json())
      .then((j: { items?: TagRow[] }) => setTags(Array.isArray(j.items) ? j.items : []))
      .catch(() => {});
    fetchActressDisks()
      .then((d) => setDisks(d.disks))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 搜索防抖 300ms（对齐原始资料页惯例）
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(qInput);
      refresh(qInput.trim());
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  const submitForm = async (payload: ActressUpsertRequest) => {
    if (editing === 'create') await createActress(payload);
    else if (editing) await updateActress(editing.id, payload);
    setEditing(null);
    refresh();
  };

  const doDelete = async (id: number) => {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      await deleteActress(id);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="card mb-4 flex shrink-0 flex-wrap items-center gap-3 p-4">
        <input
          className="min-w-40 flex-1"
          placeholder="搜索女优（名字或别名）"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
        />
        <button type="button" className="act act-primary shrink-0" onClick={() => setEditing('create')}>
          添加女优
        </button>
      </div>

      {err ? <p className="mb-3 shrink-0 text-xs text-err">{err}</p> : null}

      {items != null && items.length === 0 ? (
        <div className="shrink-0 rounded-xl border border-dashed border-line py-14 text-center text-dim">
          {q ? '没有匹配的女优' : '还没有女优，添加第一位吧'}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="grid grid-cols-2 content-start gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
            {(items ?? []).map((it) => (
              <div
                key={it.id}
                className="card group/actress relative flex flex-col p-3 transition-[border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-brand/60"
              >
                <span className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity duration-150 group-hover/actress:opacity-100">
                  <button
                    type="button"
                    className="flex size-6 items-center justify-center rounded-md bg-raised text-dim transition-colors hover:bg-brand-soft hover:text-brand-hover disabled:cursor-default disabled:opacity-40"
                    aria-label={`编辑 ${it.name}`}
                    title="编辑（名字/国家/评分/标签/别名）"
                    onClick={() => setEditing(it)}
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M4.5 19.5h3L19 8a2.1 2.1 0 0 0-3-3L4.5 15.5v4z" />
                    </svg>
                  </button>
                  <TrashButton label={`删除 ${it.name}`} title="删除女优" disabled={busy} onClick={() => setRemoving(it)} />
                </span>

                <div className="flex h-24 items-center justify-center overflow-hidden rounded-lg bg-raised">
                  {it.avatar_file_id ? (
                    <img
                      src={`/api/raw/file/${it.avatar_file_id}/content`}
                      alt={`${it.name} 头像`}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="text-2xl font-bold text-dim/50" aria-hidden>
                      {it.name.slice(0, 1)}
                    </span>
                  )}
                </div>

                <span
                  className="mt-2 cursor-text truncate text-[13px] font-medium transition-colors hover:text-brand-hover"
                  title={`${it.name}（点击编辑）`}
                  onClick={() => setEditing(it)}
                >
                  {it.name}
                </span>
                <div className="mt-1 flex items-center gap-2 text-xs text-dim">
                  <span>{it.country_name || '—'}</span>
                  <span>·</span>
                  <span className="font-mono">{it.rating == null ? '未评分' : it.rating}</span>
                </div>
                {it.tags.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1">
                    {it.tags.slice(0, 2).map((t) => (
                      <span key={t.id} className="badge">
                        {t.name}
                      </span>
                    ))}
                    {it.tags.length > 2 ? (
                      <span className="text-xs text-dim" title={it.tags.map((t) => t.name).join('、')}>
                        +{it.tags.length - 2}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {it.aliases.length > 0 ? (
                  <div className="mt-1 truncate text-xs text-dim" title={it.aliases.join('、')}>
                    {it.aliases.slice(0, 3).join('、')}
                    {it.aliases.length > 3 ? ` 等${it.aliases.length}个` : ''}
                  </div>
                ) : null}
                <div className="mt-1 text-xs text-dim">视频 {it.video_count}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="mt-3 shrink-0 text-xs text-dim">
        创建时在所选磁盘建立 Archives/国家/女优/图集 目录树；头像从原始资料页图片卡片设置。
      </p>

      {editing ? (
        <ActressDialog
          init={editing === 'create' ? null : editing}
          countries={countries}
          tags={tags}
          disks={disks}
          onSubmit={submitForm}
          onCancel={() => setEditing(null)}
        />
      ) : null}

      {removing ? (
        <ConfirmDialog
          title="删除女优"
          description={<>确定删除「{removing.name}」？其别名与标签关联将一并清除，头像文件保留在图集目录。此操作不可恢复。</>}
          confirmText="删除"
          danger
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            doDelete(target.id);
          }}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
    </section>
  );
}
