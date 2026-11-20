import { describe, expect, it } from 'vitest';
import { can, filterMenu, firstPath, type MenuNode } from './permissions';

const menu: MenuNode[] = [
  { key: 'home', label: '工作台', path: '/' },
  {
    key: 'system',
    label: '系统管理',
    children: [
      { key: 'users', label: '员工', path: '/system/users', permission: 'system:user:read' },
      { key: 'audit', label: '日志', path: '/system/audit', permission: 'system:audit:read' },
    ],
  },
];

describe('can', () => {
  it('超级权限拥有一切', () => {
    expect(can(['*'], 'system:user:write', 'order:read')).toBe(true);
  });
  it('需要同时拥有全部权限', () => {
    expect(can(['system:user:read'], 'system:user:read')).toBe(true);
    expect(can(['system:user:read'], 'system:user:read', 'system:user:write')).toBe(false);
  });
});

describe('filterMenu', () => {
  it('没有权限的子菜单被去掉', () => {
    const result = filterMenu(menu, ['system:audit:read']);
    expect(result[1].children?.map((c) => c.key)).toEqual(['audit']);
  });
  it('子菜单全被去掉时父菜单也隐藏', () => {
    expect(filterMenu(menu, []).map((n) => n.key)).toEqual(['home']);
  });
  it('超级权限看到全部菜单', () => {
    expect(filterMenu(menu, ['*'])).toEqual(menu);
  });
});

describe('firstPath', () => {
  it('取第一个能进入的页面', () => {
    expect(firstPath(filterMenu(menu.slice(1), ['system:audit:read']))).toBe('/system/audit');
    expect(firstPath([])).toBeUndefined();
  });
});
