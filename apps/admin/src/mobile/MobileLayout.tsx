import type { ReactNode } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import { Badge, Button, Typography } from 'antd';
import {
  BellOutlined,
  HomeOutlined,
  LeftOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { NOTIFY_KEYS } from '../components/notify';

interface Tab {
  path: string;
  label: string;
  icon: ReactNode;
  badge?: number;
}

/** 手机版外框：内容 + 底部标签栏 */
export function MobileLayout() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const unread = useQuery({
    queryKey: NOTIFY_KEYS.unread,
    queryFn: () => unwrap(api.GET('/api/notifications/unread-count')),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  const tabs: Tab[] = [
    { path: '/m', label: '今天', icon: <HomeOutlined /> },
    ...(can('fulfillment:handle')
      ? [{ path: '/m/tasks', label: '任务', icon: <ThunderboltOutlined /> }]
      : []),
    ...(can('customer:read')
      ? [{ path: '/m/customers', label: '客户', icon: <TeamOutlined /> }]
      : []),
    {
      path: '/m/messages',
      label: '消息',
      icon: <BellOutlined />,
      badge: unread.data?.unread ?? 0,
    },
    { path: '/m/me', label: '我的', icon: <UserOutlined /> },
  ];
  // 最长前缀匹配：/m/tasks/xxx 也算「任务」
  const active = tabs
    .filter((t) => pathname === t.path || pathname.startsWith(`${t.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]?.path;

  // 详情页有返回按钮和自己的操作栏，不显示底部标签栏
  const isDetail = /^\/m\/(tasks|customers)\/[^/]+/.test(pathname);

  return (
    <div className={`m-app${isDetail ? ' m-app-detail' : ''}`}>
      <Outlet />
      {!isDetail && (
        <nav className="m-tabbar" aria-label="手机版导航">
          {tabs.map((t) => (
            <button
              key={t.path}
              type="button"
              className={`m-tab${active === t.path ? ' m-tab-active' : ''}`}
              aria-current={active === t.path ? 'page' : undefined}
              onClick={() => navigate(t.path)}
            >
              <Badge count={t.badge} size="small" offset={[4, 0]}>
                <span className="m-tab-icon">{t.icon}</span>
              </Badge>
              <span className="m-tab-label">{t.label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

/** 手机版页面：顶部标题栏（可带返回）+ 内容 + 可选的底部操作栏 */
export function MobilePage({
  title,
  back,
  extra,
  footer,
  children,
}: {
  title: ReactNode;
  /** 返回到哪；不传就没有返回按钮 */
  back?: string;
  extra?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const goBack = () => {
    // 从别的页面点进来的就退回去，直接打开的（例如消息链接）回到指定页面
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(back ?? '/m', { replace: true });
  };
  return (
    <div className={`m-page${footer ? ' m-page-with-footer' : ''}`}>
      <header className="m-header">
        <div className="m-header-side">
          {back && (
            <Button type="text" icon={<LeftOutlined />} aria-label="返回" onClick={goBack} />
          )}
        </div>
        <Typography.Text strong className="m-header-title" ellipsis>
          {title}
        </Typography.Text>
        <div className="m-header-side m-header-extra">{extra}</div>
      </header>
      <main className="m-body">{children}</main>
      {footer && <div className="m-footer">{footer}</div>}
    </div>
  );
}

/** 一组可以点的数字卡片 */
export function StatTiles({
  items,
  columns = 3,
}: {
  items: { label: string; value: ReactNode; to?: string; danger?: boolean; hint?: string }[];
  /** 金额这种长数字用 2 列 */
  columns?: 2 | 3;
}) {
  const navigate = useNavigate();
  return (
    <div className={`m-tiles${columns === 2 ? ' m-tiles-2' : ''}`}>
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          className="m-tile"
          disabled={!it.to}
          onClick={it.to ? () => navigate(it.to!) : undefined}
        >
          <span className={`m-tile-value${it.danger ? ' m-tile-danger' : ''}`}>{it.value}</span>
          <span className="m-tile-label">{it.label}</span>
          {it.hint && <span className="m-tile-hint">{it.hint}</span>}
        </button>
      ))}
    </div>
  );
}

/** 带标题的白色分组 */
export function Section({
  title,
  extra,
  children,
}: {
  title?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="m-section">
      {(title || extra) && (
        <div className="m-section-head">
          <span className="m-section-title">{title}</span>
          {extra}
        </div>
      )}
      {children}
    </section>
  );
}
