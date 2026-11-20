import { hasPermission } from '@crm/shared';

/** 侧边菜单的配置。permission 为空表示所有登录员工都能看到 */
export interface MenuNode {
  key: string;
  label: string;
  path?: string;
  permission?: string;
  /** 拥有其中任意一个权限即可看到 */
  anyPermission?: string[];
  children?: MenuNode[];
}

/** 是否拥有 required 里的全部权限 */
export function can(granted: readonly string[], ...required: string[]): boolean {
  return required.every((p) => hasPermission(granted, p));
}

/** 按权限过滤菜单；子菜单全部看不到时，父菜单也隐藏 */
export function filterMenu(nodes: readonly MenuNode[], granted: readonly string[]): MenuNode[] {
  const out: MenuNode[] = [];
  for (const node of nodes) {
    if (node.permission && !can(granted, node.permission)) continue;
    if (node.anyPermission && !node.anyPermission.some((p) => can(granted, p))) continue;
    if (node.children) {
      const children = filterMenu(node.children, granted);
      if (children.length === 0) continue;
      out.push({ ...node, children });
    } else {
      out.push(node);
    }
  }
  return out;
}

/** 登录后默认进入的页面：第一个有权限的菜单 */
export function firstPath(nodes: readonly MenuNode[]): string | undefined {
  for (const node of nodes) {
    if (node.path) return node.path;
    const child = node.children && firstPath(node.children);
    if (child) return child;
  }
  return undefined;
}
