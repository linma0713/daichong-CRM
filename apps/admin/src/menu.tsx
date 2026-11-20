import type { ReactNode } from 'react';
import {
  ApartmentOutlined,
  AuditOutlined,
  CalendarOutlined,
  ControlOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  FileTextOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  ShoppingOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { MenuNode } from './auth/permissions';

/** 侧边菜单。新增业务模块时在这里加一项，并在 router.tsx 里加路由 */
export const MENU: MenuNode[] = [
  { key: 'dashboard', label: '工作台', path: '/' },
  { key: 'customers', label: '客户', path: '/customers', permission: 'customer:read' },
  { key: 'orders', label: '订单', path: '/orders', permission: 'order:read' },
  { key: 'tasks', label: '任务工作台', path: '/tasks', permission: 'fulfillment:handle' },
  {
    key: 'subscriptions',
    label: '订阅与到期',
    path: '/subscriptions',
    anyPermission: ['customer:read', 'subscription:read'],
  },
  { key: 'catalog', label: '商品与套餐', path: '/catalog' },
  { key: 'inventory', label: '库存与成本', path: '/inventory', permission: 'inventory:read' },
  {
    key: 'system',
    label: '系统管理',
    children: [
      { key: 'users', label: '员工', path: '/system/users', permission: 'system:user:read' },
      { key: 'roles', label: '角色与权限', path: '/system/roles', permission: 'system:role:read' },
      { key: 'teams', label: '小组', path: '/system/teams', permission: 'system:user:read' },
      { key: 'settings', label: '业务设置', path: '/settings', permission: 'settings:write' },
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
  customers: <UserOutlined />,
  orders: <FileTextOutlined />,
  tasks: <ThunderboltOutlined />,
  subscriptions: <CalendarOutlined />,
  catalog: <ShoppingOutlined />,
  inventory: <DatabaseOutlined />,
  settings: <ControlOutlined />,
  system: <SettingOutlined />,
  users: <TeamOutlined />,
  roles: <SafetyCertificateOutlined />,
  teams: <ApartmentOutlined />,
  audit: <AuditOutlined />,
};
