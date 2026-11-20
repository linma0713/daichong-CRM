import { describe, expect, it } from 'vitest';
import { PASSWORD_RULE } from '@crm/shared';
import { beijingToday, formatTime, randomPassword } from './format';

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
