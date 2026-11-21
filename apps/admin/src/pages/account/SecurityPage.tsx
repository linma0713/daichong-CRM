import { useState } from 'react';
import { Link } from 'react-router';
import {
  App,
  Button,
  Card,
  Descriptions,
  Form,
  Grid,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { CheckCircleFilled, LaptopOutlined, SafetyOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap, type Schemas } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { formatShortTime, formatTime } from '../../components/format';
import { RecoveryCodes, TotpSetupFlow } from '../../components/totp';

type Session = Schemas['SessionDto'];
type LoginEvent = Schemas['LoginEventDto'];

const EVENT_TAGS: Record<string, { color: string; label: string }> = {
  'auth.login': { color: 'green', label: '登录成功' },
  'auth.login_failed': { color: 'orange', label: '密码错误' },
  'auth.totp_failed': { color: 'orange', label: '验证码错误' },
  'auth.locked': { color: 'red', label: '账号被锁定' },
  'auth.recovery_used': { color: 'gold', label: '用恢复码登录' },
};

/** 让员工输一次登录密码再执行（关闭两步验证、重新生成恢复码） */
function PasswordModal({
  title,
  okText,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  okText: string;
  danger?: boolean;
  onConfirm: (password: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [form] = Form.useForm<{ password: string }>();
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open
      title={title}
      okText={okText}
      okButtonProps={{ danger }}
      confirmLoading={busy}
      onOk={() => form.submit()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={async ({ password }) => {
          setBusy(true);
          try {
            await onConfirm(password);
          } catch {
            // 错误提示由全局统一弹出
          } finally {
            setBusy(false);
          }
        }}
      >
        <Form.Item
          name="password"
          label="请输入登录密码确认"
          rules={[{ required: true, message: '请输入登录密码' }]}
        >
          <Input.Password autoComplete="current-password" autoFocus />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function TotpCard() {
  const { message } = App.useApp();
  const { profile, reload } = useAuth();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ['auth', 'totp'],
    queryFn: () => unwrap(api.GET('/api/auth/totp')),
  });
  const [mode, setMode] = useState<'setup' | 'disable' | 'regen' | null>(null);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['auth', 'totp'] });
    await reload();
  };
  const s = status.data;
  return (
    <Card
      title={
        <Space>
          <SafetyOutlined />
          两步验证
        </Space>
      }
      loading={status.isLoading}
    >
      {s?.enabled ? (
        <Descriptions column={1} size="small">
          <Descriptions.Item label="状态">
            <Typography.Text type="success">
              <CheckCircleFilled /> 已开启
            </Typography.Text>
            {s.required && (
              <Tag style={{ marginLeft: 8 }} color="blue">
                你的岗位要求开启
              </Tag>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="开启时间">{formatTime(s.enabledAt)}</Descriptions.Item>
          <Descriptions.Item label="恢复码">
            还剩 {s.recoveryCodesLeft} 个
            {s.recoveryCodesLeft <= 2 && (
              <Typography.Text type="warning">（快用完了，建议重新生成）</Typography.Text>
            )}
          </Descriptions.Item>
        </Descriptions>
      ) : (
        <Typography.Paragraph>
          开启后，登录时除了密码还要输入手机验证器里的 6 位数字。密码泄露了，别人也登不进你的账号。
          {s?.required && <Typography.Text type="danger">你的岗位要求必须开启。</Typography.Text>}
        </Typography.Paragraph>
      )}
      <Space wrap style={{ marginTop: 12 }}>
        {s?.enabled ? (
          <>
            <Button onClick={() => setMode('regen')}>重新生成恢复码</Button>
            {!s.required && (
              <Button danger onClick={() => setMode('disable')}>
                关闭两步验证
              </Button>
            )}
          </>
        ) : (
          <Button type="primary" icon={<SafetyOutlined />} onClick={() => setMode('setup')}>
            开启两步验证
          </Button>
        )}
      </Space>
      {mode === 'setup' && (
        <Modal
          open
          title="开启两步验证"
          footer={null}
          width={640}
          maskClosable={false}
          onCancel={() => {
            setMode(null);
            void refresh();
          }}
        >
          <TotpSetupFlow
            username={profile?.username ?? ''}
            onDone={() => {
              setMode(null);
              message.success('两步验证已开启');
              void refresh();
            }}
          />
        </Modal>
      )}
      {mode === 'disable' && (
        <PasswordModal
          title="关闭两步验证"
          okText="关闭"
          danger
          onClose={() => setMode(null)}
          onConfirm={async (password) => {
            await unwrap(api.POST('/api/auth/totp/disable', { body: { password } }));
            message.success('两步验证已关闭');
            setMode(null);
            await refresh();
          }}
        />
      )}
      {mode === 'regen' && (
        <PasswordModal
          title="重新生成恢复码（旧的全部作废）"
          okText="生成"
          onClose={() => setMode(null)}
          onConfirm={async (password) => {
            const r = await unwrap(
              api.POST('/api/auth/totp/recovery-codes', { body: { password } }),
            );
            setMode(null);
            setNewCodes(r.recoveryCodes);
            await refresh();
          }}
        />
      )}
      {newCodes && (
        <Modal
          open
          title="新的恢复码"
          maskClosable={false}
          onCancel={() => setNewCodes(null)}
          footer={
            <Button type="primary" onClick={() => setNewCodes(null)}>
              我已保存好
            </Button>
          }
        >
          <RecoveryCodes codes={newCodes} username={profile?.username} />
        </Modal>
      )}
    </Card>
  );
}

/** 窄屏用短时间，表格不用横向滚动 */
function useTimeFormat() {
  return Grid.useBreakpoint().sm === false ? formatShortTime : formatTime;
}

function SessionsCard() {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const time = useTimeFormat();
  const sessions = useQuery({
    queryKey: ['auth', 'sessions'],
    queryFn: () => unwrap(api.GET('/api/auth/sessions')),
  });
  const done = (text: string) => {
    message.success(text);
    void queryClient.invalidateQueries({ queryKey: ['auth', 'sessions'] });
  };
  const revoke = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/api/auth/sessions/{id}', { params: { path: { id } } })),
    onSuccess: () => done('这个设备已退出登录'),
  });
  const revokeOthers = useMutation({
    mutationFn: () => unwrap(api.POST('/api/auth/sessions/revoke-others')),
    onSuccess: (r) => done(r.count ? `已退出 ${r.count} 个设备` : '没有其他设备在登录'),
  });
  const others = (sessions.data ?? []).filter((s) => !s.current).length;
  return (
    <Card
      title={
        <Space>
          <LaptopOutlined />
          登录着的设备
        </Space>
      }
      extra={
        others > 0 && (
          <Popconfirm
            title={`退出其他 ${others} 个设备？`}
            okText="全部退出"
            okButtonProps={{ danger: true }}
            onConfirm={() => revokeOthers.mutate()}
          >
            <Button danger size="small" loading={revokeOthers.isPending}>
              退出其他所有设备
            </Button>
          </Popconfirm>
        )
      }
    >
      <Table<Session>
        rowKey="id"
        size="small"
        loading={sessions.isLoading}
        dataSource={
          sessions.data && [...sessions.data].sort((x, y) => Number(y.current) - Number(x.current))
        }
        pagination={{ pageSize: 8, hideOnSinglePage: true, showSizeChanger: false }}
        scroll={{ x: 'max-content' }}
        columns={[
          {
            title: '设备',
            key: 'device',
            render: (_, s) => (
              <Space size={6}>
                <span>{s.device}</span>
                {s.current && <Tag color="green">当前</Tag>}
              </Space>
            ),
          },
          { title: 'IP', dataIndex: 'ip', responsive: ['md'], render: (v) => v ?? '—' },
          { title: '登录时间', key: 'created', render: (_, s) => time(s.createdAt) },
          {
            title: '最近活跃',
            key: 'seen',
            responsive: ['sm'],
            render: (_, s) => time(s.lastSeenAt),
          },
          {
            title: '',
            key: 'op',
            width: 48,
            render: (_, s) =>
              !s.current && (
                <Popconfirm
                  title="让这个设备退出登录？"
                  okText="退出"
                  onConfirm={() => revoke.mutate(s.id)}
                >
                  <Button type="link" size="small" danger>
                    退出
                  </Button>
                </Popconfirm>
              ),
          },
        ]}
      />
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '8px 0 0' }}>
        看到不认识的设备，先点「退出」，再去修改密码。修改密码也会让其他设备全部退出。
      </Typography.Paragraph>
    </Card>
  );
}

function HistoryCard() {
  const time = useTimeFormat();
  const history = useQuery({
    queryKey: ['auth', 'login-history'],
    queryFn: () => unwrap(api.GET('/api/auth/login-history')),
  });
  return (
    <Card title="最近的登录记录">
      <Table<LoginEvent>
        rowKey="id"
        size="small"
        loading={history.isLoading}
        dataSource={history.data}
        pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
        scroll={{ x: 'max-content' }}
        columns={[
          { title: '时间', key: 'at', render: (_, e) => time(e.at) },
          {
            title: '结果',
            key: 'action',
            render: (_, e) => {
              const t = EVENT_TAGS[e.action];
              return <Tag color={t?.color}>{t?.label ?? e.summary}</Tag>;
            },
          },
          { title: '设备', dataIndex: 'device', render: (v) => v ?? '—' },
          { title: 'IP', dataIndex: 'ip', responsive: ['md'], render: (v) => v ?? '—' },
        ]}
      />
    </Card>
  );
}

/** 账号安全：两步验证、登录设备、登录记录 */
export function SecurityPage() {
  return (
    <Space direction="vertical" size={16} style={{ width: '100%', maxWidth: 900 }}>
      <TotpCard />
      <SessionsCard />
      <HistoryCard />
      <Typography.Text type="secondary">
        要改密码？去 <Link to="/account/password">修改密码</Link>。
      </Typography.Text>
    </Space>
  );
}
