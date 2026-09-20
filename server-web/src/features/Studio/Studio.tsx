import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  clearStudioLogo,
  createStudio,
  deleteStudio,
  fetchStudios,
  renameStudio,
  setStudioLogo,
} from '@/lib/api';
import type { StudioRow } from '@/lib/types';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { TrashButton } from '@/components/RawCard';

/** 文件 → 纯 base64（无 data: 前缀）。导出供测试。 */
export function fileToB64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const r = String(fr.result || '');
      resolve(r.slice(r.indexOf(',') + 1));
    };
    fr.onerror = () => reject(fr.error ?? new Error('文件读取失败'));
    fr.readAsDataURL(file);
  });
}

/** 通用小图标按钮（卡片 hover 操作区，与 TrashButton 同款弱化风格）。 */
function IconAction({
  label,
  title,
  tone = 'brand',
  disabled,
  onClick,
  children,
}: {
  label: string;
  title: string;
  tone?: 'brand' | 'err';
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`flex size-6 items-center justify-center rounded-md bg-raised text-dim transition-colors disabled:cursor-default disabled:opacity-40 ${
        tone === 'brand' ? 'hover:bg-brand-soft hover:text-brand-hover' : 'hover:bg-err-soft hover:text-err'
      }`}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** logo 设置弹窗：上传文件 / 粘贴 URL 二选一（均带预览）；已有 logo 附「清除」。 */
function LogoDialog({
  studio,
  logoVersion,
  onDone,
  onCancel,
}: {
  studio: StudioRow;
  logoVersion: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [filePreview, setFilePreview] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const dlgRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dlgRef.current;
    if (d && !d.open) d.showModal();
  }, []);

  const urlTrim = url.trim();
  const preview = filePreview || urlTrim;

  const pickFile = (f: File | null) => {
    setFile(f);
    if (!f) {
      setFilePreview('');
      return;
    }
    const fr = new FileReader();
    fr.onload = () => setFilePreview(String(fr.result || ''));
    fr.readAsDataURL(f);
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      if (file) await setStudioLogo(studio.id, { b64: await fileToB64(file) });
      else if (urlTrim) await setStudioLogo(studio.id, { url: urlTrim });
      else throw new Error('请选择文件或粘贴图片地址');
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doClear = async () => {
    if (busy) return;
    setBusy(true);
    setErr('');
    try {
      await clearStudioLogo(studio.id);
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <dialog ref={dlgRef} onClose={onCancel} closedby="any">
      <div className="mb-1 text-[15px] font-bold">设置 logo · {studio.name}</div>
      {studio.has_logo ? (
        <div className="mb-3 flex items-center gap-3">
          <img
            src={`/api/studios/${studio.id}/logo?v=${logoVersion}`}
            alt={`${studio.name} 当前 logo`}
            className="max-h-14 max-w-[120px] object-contain"
          />
          <button type="button" className="act act-danger ml-auto shrink-0" disabled={busy} onClick={doClear}>
            清除 logo
          </button>
        </div>
      ) : null}
      <form onSubmit={submit}>
        <label className="block text-xs text-dim" htmlFor="studio-logo-file">
          上传文件（jpg / png / webp，≤512KB）
        </label>
        <input
          id="studio-logo-file"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="mt-1.5 w-full"
          onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
        />
        <div className="my-2 text-center text-xs text-dim">或</div>
        <label className="block text-xs text-dim" htmlFor="studio-logo-url">
          粘贴图片地址（服务端抓取）
        </label>
        <input
          id="studio-logo-url"
          type="url"
          className="mt-1.5 w-full"
          placeholder="https://…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        {preview ? (
          <div className="mt-3 flex h-20 items-center justify-center rounded-lg bg-raised p-2">
            <img src={preview} alt="预览" className="max-h-full max-w-full object-contain" />
          </div>
        ) : null}
        {err ? <p className="mt-2 text-xs text-err">{err}</p> : null}
        <div className="mt-3.5 flex justify-end gap-2.5">
          <button type="button" className="act" onClick={() => dlgRef.current?.close()}>
            取消
          </button>
          <button type="submit" className="act act-primary" disabled={busy || (!file && !urlTrim)}>
            保存
          </button>
        </div>
      </form>
    </dialog>
  );
}

/**
 * 片商页面：字典 CRUD + logo 管理（仅网格视图）。
 * 卡片 = logo 展示区（无 logo 渲染名字首字占位）+ 名字（点击改名）+ 视频/演员计数（预留恒 0）；
 * hover 操作区：🖼 设置 logo / ✎ 改名 / 🗑 删除。logo 更新后 ?v= 版本号 bust 浏览器缓存。
 */
export function Studio() {
  const [items, setItems] = useState<StudioRow[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [removing, setRemoving] = useState<StudioRow | null>(null);
  const [logoTarget, setLogoTarget] = useState<StudioRow | null>(null);
  const [logoVersion, setLogoVersion] = useState(0);
  const editInputRef = useRef<HTMLInputElement>(null);

  const refresh = () => {
    fetchStudios()
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
      await createStudio(n);
      setName('');
    });
  };

  const submitRename = (it: StudioRow) => {
    const n = draft.trim();
    if (!n) return;
    if (n === it.name) {
      setEditingId(null);
      return;
    }
    run(async () => {
      await renameStudio(it.id, n);
      setEditingId(null);
    });
  };

  const nameNode = (it: StudioRow) =>
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

  const cardActions = (it: StudioRow) => (
    <span className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity duration-150 group-hover/studio:opacity-100">
      <IconAction label={`设置 logo ${it.name}`} title="设置 logo" disabled={busy} onClick={() => setLogoTarget(it)}>
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
          <circle cx="8.7" cy="10" r="1.6" />
          <path d="M20.5 15.5l-4.6-4.6L6.2 20.5" />
        </svg>
      </IconAction>
      <IconAction label={`改名 ${it.name}`} title="改名" disabled={busy} onClick={() => { setEditingId(it.id); setDraft(it.name); }}>
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4.5 19.5h3L19 8a2.1 2.1 0 0 0-3-3L4.5 15.5v4z" />
        </svg>
      </IconAction>
      <TrashButton label={`删除 ${it.name}`} title="删除片商" disabled={busy} onClick={() => setRemoving(it)} />
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
            placeholder="片商名（如：某制作组）"
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
          还没有片商，添加第一个吧
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="grid grid-cols-2 content-start gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
            {(items ?? []).map((it) => (
              <div
                key={it.id}
                className="card group/studio relative flex flex-col p-3 transition-[border-color,transform] duration-150 hover:-translate-y-0.5 hover:border-brand/60"
              >
                {cardActions(it)}
                <div className="flex h-20 items-center justify-center overflow-hidden rounded-lg bg-raised">
                  {it.has_logo ? (
                    <img
                      src={`/api/studios/${it.id}/logo?v=${logoVersion}`}
                      alt={`${it.name} logo`}
                      className="max-h-full max-w-full object-contain"
                    />
                  ) : (
                    <span className="text-2xl font-bold text-dim/50" aria-hidden>
                      {it.name.slice(0, 1)}
                    </span>
                  )}
                </div>
                <div className="mt-2 flex min-w-0 items-center gap-2">{nameNode(it)}</div>
                <div className="mt-1.5 flex items-center gap-2 text-xs text-dim">
                  <span>视频 {it.video_count}</span>
                  <span>·</span>
                  <span>演员 {it.actor_count}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="mt-3 shrink-0 text-xs text-dim">
        片商将直接关联视频；卡片计数在关联功能落地后开始真实统计（演员数 = 片商视频关联演员的去重数）。
      </p>

      {logoTarget ? (
        <LogoDialog
          studio={logoTarget}
          logoVersion={logoVersion}
          onDone={() => {
            setLogoTarget(null);
            setLogoVersion((v) => v + 1); // ?v= bust 浏览器对 logo 的短缓存
            refresh();
          }}
          onCancel={() => setLogoTarget(null)}
        />
      ) : null}

      {removing ? (
        <ConfirmDialog
          title="删除片商"
          description={<>确定删除「{removing.name}」？其 logo 将一并删除，此操作不可恢复。</>}
          confirmText="删除"
          danger
          onConfirm={() => {
            const target = removing;
            setRemoving(null);
            run(() => deleteStudio(target.id));
          }}
          onCancel={() => setRemoving(null)}
        />
      ) : null}
    </section>
  );
}
