import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { createTag, deleteTag, fetchTags, renameTag, reorderTags } from '@/lib/api';
import type { TagRow } from '@/lib/types';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { TrashButton } from '@/components/RawCard';

type View = 'grid' | 'row';
const VIEW_KEY = 'tag-view';

/**
 * 纯函数：把 dragId 移到 targetId 的前/后（其余相对顺序不变）。导出供组件测试直接验证排序逻辑
 * （happy-dom 不派发真实 DnD 事件，拖拽链路以此函数为单点真相）。
 */
export function insertRelativeTo<T extends { id: number }>(
  items: T[],
  dragId: number,
  targetId: number,
  before: boolean,
): T[] {
  if (dragId === targetId) return items;
  const drag = items.find((t) => t.id === dragId);
  if (!drag) return items;
  const rest = items.filter((t) => t.id !== dragId);
  const idx = rest.findIndex((t) => t.id === targetId);
  if (idx < 0) return items;
  rest.splice(before ? idx : idx + 1, 0, drag);
  return rest;
}

/** 拖拽把手（mousedown 激活所在卡片 draggable，避免整卡误拖；mouseup/拖完解除）。 */
function Handle({ label, onArm, onDisarm }: { label: string; onArm: () => void; onDisarm: () => void }) {
  return (
    <button
      type="button"
      className="shrink-0 cursor-grab select-none px-0.5 text-dim leading-none transition-colors hover:text-ink active:cursor-grabbing"
      title="拖动调整顺序"
      aria-label={`拖动排序 ${label}`}
      onMouseDown={onArm}
      onMouseUp={onDisarm}
      draggable={false}
    >
      ⠿
    </button>
  );
}

/**
 * 标签页面：字典 CRUD + 拖拽排序。
 * 网格（默认）/行视图（localStorage 记忆）；把手拖动 → 插入位反馈 → 松手乐观重排 + 立即落库（失败回滚重拉）。
 */
export function Tag() {
  const [view, setView] = useState<View>(() => (localStorage.getItem(VIEW_KEY) === 'row' ? 'row' : 'grid'));
  const [items, setItems] = useState<TagRow[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [removing, setRemoving] = useState<TagRow | null>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  // 拖拽状态：armed = 把手按下激活 draggable 的卡片；dragging = 拖动中；hover = 当前落点（前后指示）
  const [armed, setArmed] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [hover, setHover] = useState<{ id: number; before: boolean } | null>(null);
  const ordering = useRef(false);

  const refresh = () => {
    fetchTags()
      .then((d) => setItems(d.items))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };

  useEffect(refresh, []);

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
      await createTag(n);
      setName('');
    });
  };

  const submitRename = (it: TagRow) => {
    const n = draft.trim();
    if (!n) return;
    if (n === it.name) {
      setEditingId(null);
      return;
    }
    run(async () => {
      await renameTag(it.id, n);
      setEditingId(null);
    });
  };

  const switchView = (v: View) => {
    setView(v);
    localStorage.setItem(VIEW_KEY, v);
  };

  // ---- 拖拽排序（HTML5 原生 DnD；网格按水平中线、行按垂直中线判定前/后插入） ----

  const onDragStart = (e: DragEvent, it: TagRow) => {
    setDragging(it.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(it.id)); // Firefox 需要 data 才能启动拖动
  };

  const onDragEnd = () => {
    setDragging(null);
    setHover(null);
    setArmed(null);
  };

  const onDragOver = (e: DragEvent, it: TagRow) => {
    if (dragging == null || dragging === it.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const before = view === 'grid' ? e.clientX < r.left + r.width / 2 : e.clientY < r.top + r.height / 2;
    setHover((h) => (h?.id === it.id && h.before === before ? h : { id: it.id, before }));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const dragId = dragging;
    const target = hover;
    setDragging(null);
    setHover(null);
    setArmed(null);
    if (dragId == null || !target || dragId === target.id || !items) return;
    commitOrder(insertRelativeTo(items, dragId, target.id, target.before));
  };

  const commitOrder = (next: TagRow[]) => {
    if (ordering.current) return;
    ordering.current = true;
    setItems(next); // 乐观重排
    setErr('');
    reorderTags(next.map((t) => t.id))
      .then((d) => setItems(d.items)) // 服务端权威顺序（含不存在 id 忽略语义）
      .catch((e) => {
        setErr(`排序保存失败：${e instanceof Error ? e.message : String(e)}`);
        refresh(); // 回滚：重拉权威列表
      })
      .finally(() => {
        ordering.current = false;
      });
  };

  const cardCls = (it: TagRow) =>
    `card group/tag relative p-3 transition-[border-color,transform] duration-150 ${
      dragging === it.id ? 'opacity-40' : 'hover:border-brand/60'
    }`;

  // 网格落点指示条（左/右缘）；行视图用整行高亮（onDragOver 处的 tr 上加类）
  const gridIndicator = (it: TagRow) =>
    hover?.id === it.id ? (
      <span
        aria-hidden
        className={`absolute top-2 bottom-2 w-[3px] rounded bg-brand ${hover.before ? 'left-0' : 'right-0'}`}
      />
    ) : null;

  const nameNode = (it: TagRow) =>
    editingId === it.id ? (
      <input
        ref={editInputRef}
        value={draft}
        maxLength={60}
        className="min-w-0 flex-1"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submitRename(it);
          else if (e.key === 'Escape') setEditingId(null);
        }}
        onBlur={() => setEditingId((cur) => (cur === it.id ? null : cur))}
      />
    ) : (
      <span
        className="cursor-text truncate text-[13px] font-medium transition-colors hover:text-brand-hover"
        title={`${it.name}（点击改名）`}
        onClick={() => {
          if (!busy) {
            setEditingId(it.id);
            setDraft(it.name);
          }
        }}
      >
        {it.name}
      </span>
    );

  // 卡片操作：hover 右上角浮现小图标（与 RawCard 视觉语言一致），平时零视觉占位
  const cardActions = (it: TagRow) => (
    <span className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity duration-150 group-hover/tag:opacity-100">
      <button
        type="button"
        className="flex size-6 items-center justify-center rounded-md bg-raised text-dim transition-colors hover:bg-brand-soft hover:text-brand-hover disabled:cursor-default disabled:opacity-40"
        aria-label={`改名 ${it.name}`}
        title="改名"
        disabled={busy}
        onClick={() => {
          setEditingId(it.id);
          setDraft(it.name);
        }}
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4.5 19.5h3L19 8a2.1 2.1 0 0 0-3-3L4.5 15.5v4z" />
        </svg>
      </button>
      <TrashButton label={`删除 ${it.name}`} title="删除标签" disabled={busy} onClick={() => setRemoving(it)} />
    </span>
  );

  // 行视图操作列（表格操作列是惯例，保留文字按钮）
  const actions = (it: TagRow) => (
    <span className="ml-auto flex shrink-0 gap-1.5">
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
    </span>
  );

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="card mb-4 flex shrink-0 flex-wrap items-center gap-3 p-4">
        <form className="flex flex-1 items-center gap-2.5" onSubmit={submitAdd}>
          <input
            className="min-w-40 flex-1"
            value={name}
            maxLength={60}
            placeholder="标签名（如：高清）"
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="act act-primary shrink-0" disabled={busy || !name.trim()}>
            添加
          </button>
        </form>
        <div className="flex shrink-0 gap-1.5" role="group" aria-label="视图切换">
          <button type="button" className={`act ${view === 'grid' ? 'act-primary' : ''}`} aria-pressed={view === 'grid'} onClick={() => switchView('grid')}>
            网格
          </button>
          <button type="button" className={`act ${view === 'row' ? 'act-primary' : ''}`} aria-pressed={view === 'row'} onClick={() => switchView('row')}>
            行
          </button>
        </div>
      </div>

      {err ? <p className="mb-3 shrink-0 text-xs text-err">{err}</p> : null}

      {items != null && items.length === 0 ? (
        <div className="shrink-0 rounded-xl border border-dashed border-line py-14 text-center text-dim">
          还没有标签，添加第一个吧
        </div>
      ) : view === 'grid' ? (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="grid grid-cols-2 content-start gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
            {(items ?? []).map((it) => (
              <div
                key={it.id}
                className={cardCls(it)}
                draggable={armed === it.id}
                onDragStart={(e) => onDragStart(e, it)}
                onDragEnd={onDragEnd}
                onDragOver={(e) => onDragOver(e, it)}
                onDrop={onDrop}
              >
                {gridIndicator(it)}
                {cardActions(it)}
                <div className="flex items-center gap-2">
                  <Handle label={it.name} onArm={() => setArmed(it.id)} onDisarm={() => setArmed(null)} />
                  {nameNode(it)}
                </div>
                <div className="mt-2 flex items-center gap-2 text-xs text-dim">
                  <span>视频 {it.video_count}</span>
                  <span>·</span>
                  <span>演员 {it.actor_count}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="card min-h-0 flex-1 overflow-auto p-5">
          <table>
            <thead>
              <tr>
                <th className="w-8" aria-label="排序把手" />
                <th>名称</th>
                <th>关联</th>
                <th className="w-40">操作</th>
              </tr>
            </thead>
            <tbody>
              {(items ?? []).map((it) => (
                <tr
                  key={it.id}
                  className={hover?.id === it.id ? '[box-shadow:inset_0_0_0_1px_var(--color-brand)]' : ''}
                  onDragOver={(e) => onDragOver(e, it)}
                  onDrop={onDrop}
                >
                  <td>
                    <Handle label={it.name} onArm={() => setArmed(it.id)} onDisarm={() => setArmed(null)} />
                  </td>
                  <td className="max-w-[520px]">{nameNode(it)}</td>
                  <td className="text-xs text-dim">
                    视频 {it.video_count} · 演员 {it.actor_count}
                  </td>
                  <td>{actions(it)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 shrink-0 text-xs text-dim">
        拖动 ⠿ 调整标签顺序；标签可挂演员与视频，视频最终标签 = 直挂 ∪ 演员标签。
      </p>

      {removing ? (
        <ConfirmDialog
          title="删除标签"
          description={<>确定删除「{removing.name}」？此操作不可恢复。</>}
          confirmText="删除"
          danger
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            run(() => deleteTag(target.id));
          }}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
    </section>
  );
}
