import { describe, expect, it } from 'vitest';
import { PASSWORD_RULE } from '@crm/shared';
import { formatTime, randomPassword } from './format';

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
