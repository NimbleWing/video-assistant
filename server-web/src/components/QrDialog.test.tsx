import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchLan } from '@/lib/api';
import { QrDialog } from './QrDialog';

vi.mock('@/lib/api', () => ({
  fetchLan: vi.fn(),
}));
const mockedLan = vi.mocked(fetchLan);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('QrDialog（手机扫码访问）', () => {
  it('展示局域网 URL 二维码；多网卡 chips 可切换', async () => {
    mockedLan.mockResolvedValue({ ok: true, port: 17321, ips: ['192.168.1.8', '10.0.0.2'] });
    render(<QrDialog onClose={() => {}} />);
    // 默认第一个 IP：URL 文本 + SVG 二维码
    expect(await screen.findByText('http://192.168.1.8:17321/')).toBeTruthy();
    expect(document.querySelector('svg')).toBeTruthy();
    // 切换到第二个 IP
    fireEvent.click(screen.getByText('10.0.0.2'));
    expect(await screen.findByText('http://10.0.0.2:17321/')).toBeTruthy();
  });

  it('无局域网地址 / 拉取失败的空态与错误态', async () => {
    mockedLan.mockResolvedValue({ ok: true, port: 17321, ips: [] });
    const { unmount } = render(<QrDialog onClose={() => {}} />);
    expect(await screen.findByText(/未探测到局域网 IPv4 地址/)).toBeTruthy();
    unmount();
    mockedLan.mockRejectedValue(new Error('服务未启动'));
    render(<QrDialog onClose={() => {}} />);
    expect(await screen.findByText('服务未启动')).toBeTruthy();
  });
});
