import { describe, expect, it } from 'vitest';
import { hasPermission, mergePermissions, widestDataScope, PASSWORD_RULE } from './index';

describe('角色与权限', () => {
  it('多个角色取最大数据范围', () => {
    expect(widestDataScope([])).toBe('SELF');
    expect(widestDataScope(['SELF', 'TEAM'])).toBe('TEAM');
    expect(widestDataScope(['TEAM', 'ALL', 'SELF'])).toBe('ALL');
  });

  it('权限取并集并去重', () => {
    expect(
      mergePermissions([
        ['b', 'a'],
        ['a', 'c'],
      ]),
    ).toEqual(['a', 'b', 'c']);
    expect(mergePermissions([['a'], ['*']])).toEqual(['*']);
  });

  it('超级权限包含所有权限', () => {
    expect(hasPermission(['*'], 'system:user:write')).toBe(true);
    expect(hasPermission(['system:user:read'], 'system:user:write')).toBe(false);
  });

  it('密码规则', () => {
    expect(PASSWORD_RULE.pattern.test('abc12345')).toBe(true);
    expect(PASSWORD_RULE.pattern.test('12345678')).toBe(false);
    expect(PASSWORD_RULE.pattern.test('abcdefgh')).toBe(false);
    expect(PASSWORD_RULE.pattern.test('a1')).toBe(false);
  });
});
