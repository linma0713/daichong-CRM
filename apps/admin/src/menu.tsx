import type { ReactNode } from 'react';
import {
  ApartmentOutlined,
  AuditOutlined,
  DashboardOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import type { MenuNode } from './auth/permissions';

/** 侧边菜单。新增业务模块时在这里加一项，并在 router.tsx 里加路由 */
export const MENU: MenuNode[] = [
  { key: 'dashboard', label: '工作台', path: '/' },
  {
    key: 'system',
    label: '系统管理',
    children: [
      { key: 'users', label: '员工', path: '/system/users', permission: 'system:user:read' },
      { key: 'roles', label: '角色与权限', path: '/system/roles', permission: 'system:role:read' },
      { key: 'teams', label: '小组', path: '/system/teams', permission: 'system:user:read' },
      {
        key: 'audit',
        label: '操作日志',
        path: '/system/audit-logs',
        permission: 'system:audit:read',
      },
    ],
  },
];

export const MENU_ICONS: Record<string, ReactNode> = {
  dashboard: <DashboardOutlined />,
  system: <SettingOutlined />,
  users: <TeamOutlined />,
  roles: <SafetyCertificateOutlined />,
  teams: <ApartmentOutlined />,
  audit: <AuditOutlined />,
};
