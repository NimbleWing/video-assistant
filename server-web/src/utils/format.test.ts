import { describe, expect, it } from 'vitest';
import { fmtDate, fmtDur, fmtSize, fmtTime } from './format';

describe('fmtSize', () => {
  it('空值返回 -', () => {
    expect(fmtSize(0)).toBe('-');
    expect(fmtSize(null)).toBe('-');
    expect(fmtSize(undefined)).toBe('-');
  });

  it('字节', () => {
    expect(fmtSize(512)).toBe('512 B');
    expect(fmtSize(1023)).toBe('1023 B');
  });

  it('进位与保留一位小数', () => {
    expect(fmtSize(1024)).toBe('1.0 KB');
    expect(fmtSize(1536)).toBe('1.5 KB');
    expect(fmtSize(1024 * 1024)).toBe('1.0 MB');
    expect(fmtSize(1024 ** 4)).toBe('1.0 TB');
  });

  it('数值 >= 100 不保留小数', () => {
    expect(fmtSize(200 * 1024 * 1024)).toBe('200 MB');
  });
});

describe('fmtDur', () => {
  it('空值/非正数返回空串', () => {
    expect(fmtDur(0)).toBe('');
    expect(fmtDur(null)).toBe('');
    expect(fmtDur(undefined)).toBe('');
    expect(fmtDur(-3)).toBe('');
  });

  it('分:秒', () => {
    expect(fmtDur(61)).toBe('1:01');
    expect(fmtDur(3599)).toBe('59:59');
    expect(fmtDur(3600)).toBe('60:00');
  });
});

describe('fmtDate', () => {
  it('空值返回 -', () => {
    expect(fmtDate(0)).toBe('-');
    expect(fmtDate(null)).toBe('-');
  });

  it('按 zh-CN 短日期格式化', () => {
    const ms = Date.UTC(2026, 0, 2, 3, 4, 5);
    expect(fmtDate(ms)).toBe(new Date(ms).toLocaleDateString('zh-CN'));
  });
});

describe('fmtTime', () => {
  it('空值返回 -', () => {
    expect(fmtTime(0)).toBe('-');
    expect(fmtTime(null)).toBe('-');
  });

  it('按 zh-CN 无 12 小时制格式化', () => {
    const ms = Date.UTC(2026, 0, 2, 3, 4, 5);
    expect(fmtTime(ms)).toBe(new Date(ms).toLocaleString('zh-CN', { hour12: false }));
  });
});
