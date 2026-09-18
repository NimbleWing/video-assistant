import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Pager } from '.';

describe('Pager', () => {
  it('基础渲染：页码信息与禁用态', () => {
    render(<Pager page={2} pages={3} total={120} onPrev={() => {}} onNext={() => {}} />);
    expect(screen.getByText('2 / 3（共 120）')).toBeTruthy();
    expect((screen.getByText('上一页') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByText('下一页') as HTMLButtonElement).disabled).toBe(false);
  });

  it('无 onJump/size 时不渲染跳页输入与每页选择器', () => {
    render(<Pager page={1} pages={1} total={1} onPrev={() => {}} onNext={() => {}} />);
    expect(screen.queryByLabelText('跳转页码')).toBeNull();
    expect(screen.queryByLabelText('每页条数')).toBeNull();
  });

  it('跳页：输入页码回车提交并钳位', () => {
    const onJump = vi.fn();
    render(<Pager page={1} pages={9} total={90} onPrev={() => {}} onNext={() => {}} onJump={onJump} />);
    const input = screen.getByLabelText('跳转页码') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onJump).toHaveBeenCalledWith(3);
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onJump).toHaveBeenLastCalledWith(9);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onJump).toHaveBeenCalledTimes(2); // 非法输入忽略
    expect(input.value).toBe('1'); // 复位回当前页
  });

  it('跳页：失焦提交', () => {
    const onJump = vi.fn();
    render(<Pager page={1} pages={5} total={50} onPrev={() => {}} onNext={() => {}} onJump={onJump} />);
    fireEvent.change(screen.getByLabelText('跳转页码'), { target: { value: '4' } });
    fireEvent.blur(screen.getByLabelText('跳转页码'));
    expect(onJump).toHaveBeenCalledWith(4);
  });

  it('非数字输入被过滤', () => {
    render(<Pager page={1} pages={5} total={50} onPrev={() => {}} onNext={() => {}} onJump={() => {}} />);
    const input = screen.getByLabelText('跳转页码') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1a2' } });
    expect(input.value).toBe('12');
  });

  it('每页条数切换回调', () => {
    const onSizeChange = vi.fn();
    render(
      <Pager page={1} pages={5} total={100} onPrev={() => {}} onNext={() => {}} size={50} onSizeChange={onSizeChange} />,
    );
    fireEvent.change(screen.getByLabelText('每页条数'), { target: { value: '100' } });
    expect(onSizeChange).toHaveBeenCalledWith(100);
  });
});
