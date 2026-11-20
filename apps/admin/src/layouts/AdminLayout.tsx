import { useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router';
import {
  Avatar,
  Button,
  Drawer,
  Dropdown,
  Grid,
  Layout,
  Menu,
  Space,
  Typography,
  type MenuProps,
} from 'antd';
import {
  KeyOutlined,
  LogoutOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useAuth } from '../auth/AuthProvider';
import { filterMenu, type MenuNode } from '../auth/permissions';
import { MENU, MENU_ICONS } from '../menu';

type MenuItem = Required<MenuProps>['items'][number];

function toItems(nodes: MenuNode[]): MenuItem[] {
  return nodes.map((n) => ({
    key: n.path ?? n.key,
    label: n.label,
    icon: MENU_ICONS[n.key],
    children: n.children ? toItems(n.children) : undefined,
  }));
}

/** 当前路径对应的菜单项：取最长的匹配前缀 */
function selectedKey(pathname: string, nodes: MenuNode[]): string {
  const paths = nodes.flatMap((n) => (n.children ?? [n]).map((c) => c.path ?? ''));
  const hit = paths
    .filter((p) => p && (p === '/' ? pathname === '/' : pathname.startsWith(p)))
    .sort((a, b) => b.length - a.length)[0];
  return hit ?? pathname;
}

export function AdminLayout() {
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const screens = Grid.useBreakpoint();
  // 窄屏（手机）用抽屉菜单，宽屏用侧边栏
  const isMobile = screens.lg === false;
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const menu = useMemo(() => filterMenu(MENU, profile?.permissions ?? []), [profile]);
  const items = useMemo(() => toItems(menu), [menu]);
  const openKeys = useMemo(() => menu.filter((n) => n.children).map((n) => n.key), [menu]);

  const userMenu: MenuProps['items'] = [
    { key: 'password', icon: <KeyOutlined />, label: '修改密码' },
    { type: 'divider' },
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录', danger: true },
  ];

  const onUserMenu: MenuProps['onClick'] = async ({ key }) => {
    if (key === 'password') navigate('/account/password');
    if (key === 'logout') {
      await logout();
      navigate('/login', { replace: true });
    }
  };

  const navMenu = (
    <Menu
      mode="inline"
      items={items}
      selectedKeys={[selectedKey(location.pathname, menu)]}
      defaultOpenKeys={openKeys}
      onClick={({ key }) => {
        navigate(key);
        setDrawerOpen(false);
      }}
      style={{ borderInlineEnd: 'none' }}
    />
  );

  const menuOpen = isMobile ? drawerOpen : !collapsed;

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {isMobile ? (
        <Drawer
          placement="left"
          width={240}
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          title="代充 CRM"
          styles={{ body: { padding: 0 } }}
        >
          {navMenu}
        </Drawer>
      ) : (
        <Layout.Sider
          theme="light"
          width={220}
          collapsedWidth={64}
          collapsed={collapsed}
          trigger={null}
          style={{ borderRight: '1px solid #f0f0f0' }}
        >
          <div
            style={{
              height: 56,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 600,
              fontSize: collapsed ? 14 : 16,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
            }}
          >
            {collapsed ? 'CRM' : '代充 CRM'}
          </div>
          {navMenu}
        </Layout.Sider>
      )}
      <Layout>
        <Layout.Header
          style={{
            background: '#fff',
            padding: '0 16px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #f0f0f0',
            height: 56,
            lineHeight: '56px',
          }}
        >
          <Button
            type="text"
            aria-label={menuOpen ? '收起菜单' : '展开菜单'}
            icon={menuOpen ? <MenuFoldOutlined /> : <MenuUnfoldOutlined />}
            onClick={() => (isMobile ? setDrawerOpen(true) : setCollapsed(!collapsed))}
          />
          <Dropdown menu={{ items: userMenu, onClick: onUserMenu }} placement="bottomRight">
            <Space style={{ cursor: 'pointer' }}>
              <Avatar size="small" icon={<UserOutlined />} />
              <Typography.Text>{profile?.displayName}</Typography.Text>
            </Space>
          </Dropdown>
        </Layout.Header>
        <Layout.Content style={{ padding: isMobile ? 12 : 24 }}>
          <Outlet />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
