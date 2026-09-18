import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './index';

function renderDlg(over: Partial<{ onConfirm: () => void; onCancel: () => void }> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      title="删除文件及记录？"
      description="不可恢复"
      confirmText="删除"
      danger
      onConfirm={over.onConfirm ?? onConfirm}
      onCancel={over.onCancel ?? onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe('ConfirmDialog', () => {
  it('渲染标题/说明/按钮，点确认只触发 onConfirm', () => {
    const { onConfirm, onCancel } = renderDlg();
    expect(screen.getByText('删除文件及记录？')).toBeTruthy();
    expect(screen.getByText('不可恢复')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('点取消经 close 事件触发 onCancel，不触发 onConfirm', () => {
    const { onConfirm, onCancel } = renderDlg();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
