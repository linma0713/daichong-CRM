import { describe, expect, it } from 'vitest';
import { PASSWORD_RULE } from '@crm/shared';
import dayjs from 'dayjs';
import {
  beijingToday,
  bpToPercent,
  formatShortTime,
  formatTime,
  percentToBp,
  randomPassword,
} from './format';

describe('randomPassword', () => {
  it('生成的密码总是符合密码规则', () => {
    for (let i = 0; i < 200; i++) {
      const pwd = randomPassword();
      expect(pwd).toHaveLength(10);
      expect(PASSWORD_RULE.pattern.test(pwd)).toBe(true);
    }
  });
});

describe('formatTime', () => {
  it('空值显示破折号', () => {
    expect(formatTime(null)).toBe('—');
    expect(formatShortTime(undefined)).toBe('—');
  });
  it('短时间：今年的省掉年份', () => {
    const now = dayjs('2026-11-21T12:00:00');
    expect(formatShortTime('2026-03-05T08:07:00', now)).toBe('03-05 08:07');
    expect(formatShortTime('2025-12-31T23:59:00', now)).toBe('2025-12-31 23:59');
  });
});

describe('beijingToday', () => {
  it('按北京时间取日期：UTC 20:45 已经是北京的第二天', () => {
    expect(beijingToday(Date.parse('2026-11-20T20:45:00Z')).format('YYYY-MM-DD')).toBe(
      '2026-11-21',
    );
    expect(beijingToday(Date.parse('2026-11-20T15:59:00Z')).format('YYYY-MM-DD')).toBe(
      '2026-11-20',
    );
  });
});

describe('佣金比例 万分比 ⇄ 百分比', () => {
  it('互相转换，空值保持为空', () => {
    expect(bpToPercent(1500)).toBe(15);
    expect(bpToPercent(null)).toBeNull();
    expect(percentToBp(7.5)).toBe(750);
    expect(percentToBp(0.35)).toBe(35);
    expect(percentToBp(undefined)).toBeNull();
  });
});
