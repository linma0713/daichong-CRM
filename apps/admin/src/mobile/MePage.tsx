import { useNavigate } from 'react-router';
import { Avatar, Collapse, Space, Tag, Typography } from 'antd';
import {
  DesktopOutlined,
  KeyOutlined,
  LogoutOutlined,
  RightOutlined,
  SafetyOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { DATA_SCOPE_LABELS, type DataScope } from '@crm/shared';
import { useAuth } from '../auth/AuthProvider';
import { DutySwitch } from '../components/notify';
import { setUiPref } from './device';
import { MobilePage, Section } from './MobileLayout';

/** 手机版「我的」：账号、安全设置、切换电脑版、退出 */
export function MobileMePage() {
  const { profile, logout } = useAuth();
  const navigate = useNavigate();
  if (!profile) return null;

  const rows = [
    {
      icon: <SafetyOutlined />,
      label: '账号安全（两步验证、登录设备）',
      onClick: () => navigate('/account/security'),
    },
    { icon: <KeyOutlined />, label: '修改密码', onClick: () => navigate('/account/password') },
    {
      icon: <DesktopOutlined />,
      label: '切换到电脑版',
      onClick: () => {
        setUiPref('desktop');
        navigate('/');
      },
    },
    {
      icon: <LogoutOutlined />,
      label: '退出登录',
      danger: true,
      onClick: async () => {
        await logout();
        navigate('/login', { replace: true });
      },
    },
  ];

  return (
    <MobilePage title="我的">
      <Section>
        <Space size={12} align="start">
          <Avatar size={48} icon={<UserOutlined />} />
          <div>
            <Typography.Title level={5} style={{ margin: 0 }}>
              {profile.displayName}
            </Typography.Title>
            <Typography.Text type="secondary">{profile.username}</Typography.Text>
            <div style={{ marginTop: 6 }}>
              <Space size={4} wrap>
                {profile.roles.map((r) => (
                  <Tag key={r.id} color="blue" bordered={false}>
                    {r.name}
                  </Tag>
                ))}
                <Tag bordered={false}>{DATA_SCOPE_LABELS[profile.dataScope as DataScope]}</Tag>
              </Space>
            </div>
          </div>
        </Space>
        <div style={{ marginTop: 12 }}>
          <DutySwitch />
        </div>
      </Section>

      <Section>
        <div className="m-links">
          {rows.map((r) => (
            <button
              key={r.label}
              type="button"
              className={`m-link-row${r.danger ? ' m-link-danger' : ''}`}
              onClick={r.onClick}
            >
              <span>
                {r.icon} {r.label}
              </span>
              <RightOutlined />
            </button>
          ))}
        </div>
      </Section>

      <Section>
        <Collapse
          ghost
          size="small"
          items={[
            {
              key: 'home',
              label: '把手机版放到手机桌面',
              children: (
                <Typography.Paragraph style={{ margin: 0, fontSize: 13 }}>
                  iPhone：用 Safari 打开后台，点底部的「分享」→「添加到主屏幕」。
                  <br />
                  安卓：用 Chrome 或手机自带浏览器打开，点右上角菜单 →「添加到主屏幕 / 桌面」。
                  <br />
                  添加后从桌面图标打开就是手机版，不用每次输网址。在微信里打开也能用，但微信内置浏览器不能添加到桌面。
                </Typography.Paragraph>
              ),
            },
          ]}
        />
      </Section>
    </MobilePage>
  );
}
