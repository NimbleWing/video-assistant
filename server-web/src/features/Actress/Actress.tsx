import { useEffect, useState } from 'react';
import { createActress, deleteActress, fetchActressDisks, fetchActresses, updateActress } from '@/lib/api';
import type { ActressRow, ActressUpsertRequest, CountryRow, TagRow } from '@/lib/types';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { ActressCard } from './ActressCard';
import { ActressDialog } from './ActressDialog';

/**
 * 女优页面（演员体系核心，仅网格视图）：
 * 卡片 = ActressCard（VideoCard 同款赛博结构：头像三态 + 中央编辑/删除 + 评分环改分 + 分区信息）。
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

  // 评分环改分：女优为绝对分，复用全量编辑接口（其余字段原样回传）
  const doRate = async (it: ActressRow, rating: number | null) => {
    setErr('');
    try {
      await updateActress(it.id, {
        name: it.name,
        countryId: it.country_id,
        rating,
        tagIds: it.tags.map((t) => t.id),
        aliases: it.aliases,
      });
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
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
              <ActressCard
                key={it.id}
                it={it}
                busy={busy}
                onEdit={setEditing}
                onRemove={setRemoving}
                onRate={(v, r) => void doRate(v, r)}
              />
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
