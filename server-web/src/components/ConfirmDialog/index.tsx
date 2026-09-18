import { useEffect, useRef, type ReactNode } from 'react';

interface Props {
  title: string;
  /** 补充说明（ReactNode，可放路径列表等）。 */
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作：确认按钮红系。 */
  danger?: boolean;
  /** 确认回调：父组件自行关闭（卸载本组件即可，无需先 close）。 */
  onConfirm: () => void;
  /** 取消回调（点取消按钮 / Esc / 遮罩点击触发 close 事件）。 */
  onCancel: () => void;
}

/**
 * 通用确认弹窗：原生 `<dialog>` + `closedby="any"`（Esc/遮罩点击即取消）。
 * 挂载式受控——父组件条件渲染（请求非 null 时挂载），onConfirm 后卸载即关闭。
 */
export function ConfirmDialog({
  title,
  description,
  confirmText = '确定',
  cancelText = '取消',
  danger = false,
  onConfirm,
  onCancel,
}: Props) {
  const dlgRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dlg = dlgRef.current;
    if (dlg && !dlg.open) dlg.showModal();
  }, []);

  return (
    <dialog ref={dlgRef} onClose={onCancel} closedby="any">
      <div className="mb-1 text-[15px] font-bold">{title}</div>
      {description ? <div className="mb-1 text-[13px] leading-relaxed text-dim">{description}</div> : null}
      <div className="mt-3.5 flex justify-end gap-2.5">
        <button type="button" className="act" onClick={() => dlgRef.current?.close()}>
          {cancelText}
        </button>
        <button type="button" className={`act ${danger ? 'act-danger' : 'act-primary'}`} onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    </dialog>
  );
}
