import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createCountry, deleteCountry, fetchCountries, renameCountry } from '@/lib/api';
import type { CountryRow } from '@/lib/types';
import { ConfirmDialog } from '@/components/ConfirmDialog';

/**
 * 国家页面：字典 CRUD（演员体系基石）。
 * 全量列表（id 正序）+ 顶部添加 + 行内改名（Enter 提交 / Esc 取消）+ 删除二次确认。
 */
export function Country() {
  const [items, setItems] = useState<CountryRow[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [removing, setRemoving] = useState<CountryRow | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    fetchCountries()
      .then((d) => setItems(d.items))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };

  useEffect(refresh, []);

  // 进入编辑态后聚焦输入框
  useEffect(() => {
    if (editingId != null) editInputRef.current?.focus();
  }, [editingId]);

  const run = async (op: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      await op();
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitAdd = (ev: FormEvent) => {
    ev.preventDefault();
    const n = name.trim();
    if (!n || busy) return;
    run(async () => {
      await createCountry(n);
      setName('');
    });
  };

  const submitRename = (it: CountryRow) => {
    const n = draft.trim();
    if (!n) return;
    if (n === it.name) {
      setEditingId(null);
      return;
    }
    run(async () => {
      await renameCountry(it.id, n);
      setEditingId(null);
    });
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="card mb-4 flex shrink-0 flex-wrap items-center gap-3 p-4">
        <form className="flex flex-1 items-center gap-2.5" onSubmit={submitAdd}>
          <input
            className="min-w-40 flex-1"
            value={name}
            maxLength={60}
            placeholder="国家名（如：日本）"
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="act act-primary shrink-0" disabled={busy || !name.trim()}>
            添加
          </button>
        </form>
      </div>

      {err ? <p className="mb-3 shrink-0 text-xs text-err">{err}</p> : null}

      {items != null && items.length === 0 ? (
        <div className="shrink-0 rounded-xl border border-dashed border-line py-14 text-center text-dim">
          还没有国家，添加第一个吧
        </div>
      ) : (
        <div className="card min-h-0 flex-1 overflow-auto p-5">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th className="w-40">操作</th>
              </tr>
            </thead>
            <tbody>
              {(items ?? []).map((it) => (
                <tr key={it.id}>
                  <td className="max-w-[520px]">
                    {editingId === it.id ? (
                      <input
                        ref={editInputRef}
                        value={draft}
                        maxLength={60}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') submitRename(it);
                          else if (e.key === 'Escape') setEditingId(null);
                        }}
                        onBlur={() => setEditingId((cur) => (cur === it.id ? null : cur))}
                      />
                    ) : (
                      it.name
                    )}
                  </td>
                  <td>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="act"
                        disabled={busy}
                        onClick={() => {
                          setEditingId(it.id);
                          setDraft(it.name);
                        }}
                      >
                        改名
                      </button>
                      <button type="button" className="act" disabled={busy} onClick={() => setRemoving(it)}>
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 shrink-0 text-xs text-dim">
        国家字典是演员体系的基础：演员将携带国家属性，视频国家由演员推导或人工指定。
      </p>

      {removing ? (
        <ConfirmDialog
          title="删除国家"
          description={<>确定删除「{removing.name}」？此操作不可恢复。</>}
          confirmText="删除"
          danger
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            run(() => deleteCountry(target.id));
          }}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
    </section>
  );
}
