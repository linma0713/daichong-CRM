import { useState } from 'react';
import {
  App,
  Badge,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  type TableColumnsType,
} from 'antd';
import { PlusOutlined, ReloadOutlined, SafetyOutlined } from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ALL_PERMISSIONS, PASSWORD_RULE } from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { queryKeys, useRoles, useTeams } from '../../api/queries';
import { useAuth } from '../../auth/AuthProvider';
import { formatTime, randomPassword } from '../../components/format';

type User = Schemas['UserDto'];
type UserStatus = Schemas['UserStatus'];

interface Filters {
  page: number;
  pageSize: number;
  keyword?: string;
  status?: UserStatus;
  teamId?: string;
  roleId?: string;
}

interface UserForm {
  username: string;
  displayName: string;
  password: string;
  teamId?: string | null;
  roleIds: string[];
}

export function UsersPage() {
  const { message, modal } = App.useApp();
  const { profile, can } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = can('system:user:write');

  const [filters, setFilters] = useState<Filters>({ page: 1, pageSize: 20 });
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);
  const [securing, setSecuring] = useState<User | null>(null);

  const users = useQuery({
    queryKey: queryKeys.users(filters),
    queryFn: () => unwrap(api.GET('/api/users', { params: { query: filters } })),
    placeholderData: keepPreviousData,
  });
  const roles = useRoles();
  const teams = useTeams();

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.users() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.teams });
    void queryClient.invalidateQueries({ queryKey: queryKeys.roles });
  };

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: UserStatus }) =>
      unwrap(api.PATCH('/api/users/{id}', { params: { path: { id } }, body: { status } })),
    onSuccess: (u) => {
      message.success(u.status === 'ACTIVE' ? '已启用' : '已停用，该员工已被强制退出登录');
      invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE('/api/users/{id}', { params: { path: { id } } })),
    onSuccess: () => {
      message.success('已删除');
      invalidate();
    },
  });

  const roleOptions = (roles.data ?? []).map((r) => ({ value: r.id, label: r.name }));
  const teamOptions = (teams.data ?? []).map((t) => ({ value: t.id, label: t.name }));

  const columns: TableColumnsType<User> = [
    {
      title: '员工',
      key: 'name',
      render: (_, u) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{u.displayName}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {u.username}
          </Typography.Text>
        </Space>
      ),
    },
    { title: '小组', key: 'team', render: (_, u) => u.team?.name ?? '—' },
    {
      title: '角色',
      key: 'roles',
      render: (_, u) =>
        u.roles.length ? (
          <Space size={4} wrap>
            {u.roles.map((r) => (
              <Tag key={r.id}>{r.name}</Tag>
            ))}
          </Space>
        ) : (
          '—'
        ),
    },
    {
      title: '状态',
      key: 'status',
      render: (_, u) => (
        <Space direction="vertical" size={0}>
          {u.status === 'ACTIVE' ? (
            <Badge status="success" text="正常" />
          ) : (
            <Badge status="default" text="已停用" />
          )}
          {u.mustChangePassword && (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              待修改初始密码
            </Typography.Text>
          )}
          {u.lockedUntil && (
            <Typography.Text type="danger" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              输错锁定到 {formatTime(u.lockedUntil).slice(11)}
            </Typography.Text>
          )}
          {u.totpEnabled && (
            <Typography.Text type="success" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              <SafetyOutlined /> 两步验证
            </Typography.Text>
          )}
        </Space>
      ),
    },
    { title: '最近登录', key: 'lastLoginAt', render: (_, u) => formatTime(u.lastLoginAt) },
    { title: '创建时间', key: 'createdAt', render: (_, u) => formatTime(u.createdAt) },
  ];

  if (canWrite) {
    columns.push({
      title: '操作',
      key: 'actions',
      fixed: 'right',
      render: (_, u) => {
        const isSelf = u.id === profile?.id;
        // 管理员账号只能由管理员处理（后端同样会拦）
        if (u.roles.some((r) => r.code === 'admin') && !can(ALL_PERMISSIONS)) {
          return <Typography.Text type="secondary">仅管理员可操作</Typography.Text>;
        }
        return (
          <Space size={0} wrap>
            <Button type="link" size="small" onClick={() => setEditing(u)}>
              编辑
            </Button>
            <Button type="link" size="small" onClick={() => setResetting(u)}>
              重置密码
            </Button>
            <Button type="link" size="small" onClick={() => setSecuring(u)}>
              {u.lockedUntil ? (
                <Typography.Text type="danger">解锁 / 安全</Typography.Text>
              ) : (
                '安全'
              )}
            </Button>
            {u.status === 'ACTIVE' ? (
              <Popconfirm
                title="停用这个员工？"
                description="停用后该员工会被立即退出登录，且不能再登录。"
                disabled={isSelf}
                onConfirm={() => setStatus.mutateAsync({ id: u.id, status: 'DISABLED' })}
              >
                <Button type="link" size="small" disabled={isSelf}>
                  停用
                </Button>
              </Popconfirm>
            ) : (
              <Button
                type="link"
                size="small"
                onClick={() => setStatus.mutate({ id: u.id, status: 'ACTIVE' })}
              >
                启用
              </Button>
            )}
            <Button
              type="link"
              size="small"
              danger
              disabled={isSelf}
              onClick={() =>
                modal.confirm({
                  title: `删除员工「${u.displayName}」？`,
                  content: '删除后不能再登录，历史操作记录会保留。',
                  okText: '删除',
                  okButtonProps: { danger: true },
                  onOk: () => remove.mutateAsync(u.id),
                })
              }
            >
              删除
            </Button>
          </Space>
        );
      },
    });
  }

  return (
    <Card
      title="员工"
      extra={
        canWrite && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
            新增员工
          </Button>
        )
      }
    >
      <div className="page-toolbar">
        <div className="page-toolbar-filters">
          <Input.Search
            placeholder="搜索用户名或姓名"
            allowClear
            style={{ width: 220 }}
            onSearch={(keyword) =>
              setFilters((f) => ({ ...f, page: 1, keyword: keyword || undefined }))
            }
          />
          <Select
            placeholder="状态"
            allowClear
            style={{ width: 110 }}
            options={[
              { value: 'ACTIVE', label: '正常' },
              { value: 'DISABLED', label: '已停用' },
            ]}
            onChange={(status?: UserStatus) => setFilters((f) => ({ ...f, page: 1, status }))}
          />
          <Select
            placeholder="小组"
            allowClear
            style={{ width: 140 }}
            options={teamOptions}
            onChange={(teamId?: string) => setFilters((f) => ({ ...f, page: 1, teamId }))}
          />
          <Select
            placeholder="角色"
            allowClear
            style={{ width: 140 }}
            options={roleOptions}
            onChange={(roleId?: string) => setFilters((f) => ({ ...f, page: 1, roleId }))}
          />
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void users.refetch()}>
          刷新
        </Button>
      </div>
      <Table<User>
        rowKey="id"
        columns={columns}
        dataSource={users.data?.items}
        loading={users.isFetching}
        scroll={{ x: 900 }}
        pagination={{
          current: filters.page,
          pageSize: filters.pageSize,
          total: users.data?.total,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 人`,
          onChange: (page, pageSize) => setFilters((f) => ({ ...f, page, pageSize })),
        }}
      />

      {editing && (
        <UserFormModal
          user={editing === 'new' ? null : editing}
          roleOptions={roleOptions}
          teamOptions={teamOptions}
          onClose={() => setEditing(null)}
          onSaved={invalidate}
        />
      )}
      {resetting && <ResetPasswordModal user={resetting} onClose={() => setResetting(null)} />}
      {securing && (
        <UserSecurityModal
          user={securing}
          isSelf={securing.id === profile?.id}
          onClose={() => setSecuring(null)}
          onChanged={(u) => {
            setSecuring(u);
            invalidate();
          }}
        />
      )}
    </Card>
  );
}

/** 员工的账号安全：解锁、重置两步验证、看登录设备、强制下线 */
function UserSecurityModal({
  user,
  isSelf,
  onClose,
  onChanged,
}: {
  user: User;
  isSelf: boolean;
  onClose: () => void;
  onChanged: (u: User) => void;
}) {
  const { message } = App.useApp();
  const sessions = useQuery({
    queryKey: ['users', user.id, 'sessions'],
    queryFn: () =>
      unwrap(api.GET('/api/users/{id}/sessions', { params: { path: { id: user.id } } })),
  });
  const path = { params: { path: { id: user.id } } };
  const unlock = useMutation({
    mutationFn: () => unwrap(api.POST('/api/users/{id}/unlock', path)),
    onSuccess: () => {
      message.success('已解锁，可以重新登录了');
      onChanged({ ...user, lockedUntil: null });
    },
  });
  const resetTotp = useMutation({
    mutationFn: () => unwrap(api.POST('/api/users/{id}/reset-totp', path)),
    onSuccess: () => {
      message.success('已重置两步验证，下次登录只需要密码');
      onChanged({ ...user, totpEnabled: false });
    },
  });
  const kick = useMutation({
    mutationFn: () => unwrap(api.POST('/api/users/{id}/force-logout', path)),
    onSuccess: (r) => {
      message.success(r.count ? `已让 ${r.count} 个设备退出登录` : '没有设备在登录');
      void sessions.refetch();
    },
  });
  const count = sessions.data?.length ?? 0;
  return (
    <Modal
      open
      title={`账号安全：${user.displayName}`}
      footer={null}
      width={680}
      onCancel={onClose}
    >
      <Descriptions column={1} size="small" style={{ marginBottom: 16 }}>
        <Descriptions.Item label="登录锁定">
          {user.lockedUntil ? (
            <Space wrap>
              <Typography.Text type="danger">
                密码或验证码输错太多次，锁定到 {formatTime(user.lockedUntil)}
              </Typography.Text>
              <Button size="small" loading={unlock.isPending} onClick={() => unlock.mutate()}>
                解锁
              </Button>
            </Space>
          ) : (
            '正常'
          )}
        </Descriptions.Item>
        <Descriptions.Item label="两步验证">
          {user.totpEnabled ? (
            <Space wrap>
              <Typography.Text type="success">
                <SafetyOutlined /> 已开启
              </Typography.Text>
              <Popconfirm
                title="重置这个员工的两步验证？"
                description="员工手机丢了、换了才需要重置。重置后下次登录只要密码；岗位要求的话会让他重新设置。"
                okText="重置"
                okButtonProps={{ danger: true }}
                onConfirm={() => resetTotp.mutateAsync()}
              >
                <Button size="small" danger>
                  重置
                </Button>
              </Popconfirm>
            </Space>
          ) : (
            <Typography.Text type="secondary">没开启</Typography.Text>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="最近登录">{formatTime(user.lastLoginAt)}</Descriptions.Item>
      </Descriptions>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <Typography.Text strong>登录着的设备（{count}）</Typography.Text>
        {!isSelf && count > 0 && (
          <Popconfirm
            title="让这个员工所有设备都退出登录？"
            description="员工需要重新输入密码登录。怀疑账号被盗时先强制下线，再重置密码。"
            okText="强制下线"
            okButtonProps={{ danger: true }}
            onConfirm={() => kick.mutateAsync()}
          >
            <Button size="small" danger>
              强制下线
            </Button>
          </Popconfirm>
        )}
      </div>
      <Table<Schemas['SessionDto']>
        rowKey="id"
        size="small"
        loading={sessions.isLoading}
        dataSource={sessions.data}
        pagination={{ pageSize: 8, hideOnSinglePage: true, showSizeChanger: false }}
        scroll={{ x: 520 }}
        locale={{ emptyText: '没有设备在登录' }}
        columns={[
          { title: '设备', dataIndex: 'device' },
          { title: 'IP', dataIndex: 'ip', render: (v) => v ?? '—' },
          { title: '登录时间', key: 'c', render: (_, x) => formatTime(x.createdAt) },
          { title: '最近活跃', key: 's', render: (_, x) => formatTime(x.lastSeenAt) },
        ]}
      />
    </Modal>
  );
}

function UserFormModal({
  user,
  roleOptions,
  teamOptions,
  onClose,
  onSaved,
}: {
  user: User | null;
  roleOptions: { value: string; label: string }[];
  teamOptions: { value: string; label: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { message, modal } = App.useApp();
  const [form] = Form.useForm<UserForm>();
  const isNew = user === null;

  const save = useMutation({
    mutationFn: (v: UserForm) =>
      isNew
        ? unwrap(api.POST('/api/users', { body: { ...v, teamId: v.teamId ?? null } }))
        : unwrap(
            api.PATCH('/api/users/{id}', {
              params: { path: { id: user.id } },
              body: { displayName: v.displayName, teamId: v.teamId ?? null, roleIds: v.roleIds },
            }),
          ),
    onSuccess: (saved, v) => {
      onSaved();
      onClose();
      if (isNew) {
        modal.success({
          title: '员工已创建',
          content: (
            <div>
              <p>请把下面的登录信息发给 {saved.displayName}，首次登录需要修改密码：</p>
              <Typography.Paragraph
                copyable={{ text: `用户名：${saved.username}\n初始密码：${v.password}` }}
              >
                用户名：{saved.username}
                <br />
                初始密码：{v.password}
              </Typography.Paragraph>
            </div>
          ),
        });
      } else {
        message.success('已保存');
      }
    },
  });

  return (
    <Modal
      open
      title={isNew ? '新增员工' : `编辑员工：${user.displayName}`}
      okText="保存"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Form<UserForm>
        form={form}
        layout="vertical"
        initialValues={
          isNew
            ? { roleIds: [], password: randomPassword() }
            : {
                username: user.username,
                displayName: user.displayName,
                teamId: user.team?.id ?? null,
                roleIds: user.roles.map((r) => r.id),
              }
        }
        onFinish={(v) => save.mutate(v)}
      >
        <Form.Item
          name="username"
          label="登录用户名"
          rules={[
            { required: true, message: '请输入用户名' },
            { pattern: /^[A-Za-z0-9_.-]{3,32}$/, message: '3–32 位字母、数字、下划线、点或横线' },
          ]}
          extra={isNew ? '创建后不能修改' : undefined}
        >
          <Input disabled={!isNew} autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="displayName"
          label="姓名"
          rules={[{ required: true, message: '请输入姓名' }]}
        >
          <Input maxLength={32} />
        </Form.Item>
        {isNew && (
          <Form.Item
            label="初始密码"
            required
            extra={`${PASSWORD_RULE.message}；员工首次登录需修改`}
          >
            <Space.Compact style={{ width: '100%' }}>
              <Form.Item
                name="password"
                noStyle
                rules={[
                  { required: true, message: '请输入初始密码' },
                  { pattern: PASSWORD_RULE.pattern, message: PASSWORD_RULE.message },
                ]}
              >
                <Input autoComplete="off" />
              </Form.Item>
              <Button onClick={() => form.setFieldValue('password', randomPassword())}>
                随机生成
              </Button>
            </Space.Compact>
          </Form.Item>
        )}
        <Form.Item name="teamId" label="小组">
          <Select allowClear placeholder="不属于任何小组" options={teamOptions} />
        </Form.Item>
        <Form.Item name="roleIds" label="角色" extra="可以多选，权限取所有角色的并集">
          <Select
            mode="multiple"
            placeholder="选择角色"
            options={roleOptions}
            optionFilterProp="label"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function ResetPasswordModal({ user, onClose }: { user: User; onClose: () => void }) {
  const { modal } = App.useApp();
  const [password, setPassword] = useState(randomPassword);
  const valid = PASSWORD_RULE.pattern.test(password);

  const reset = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/users/{id}/reset-password', {
          params: { path: { id: user.id } },
          body: { password },
        }),
      ),
    onSuccess: () => {
      onClose();
      modal.success({
        title: '密码已重置',
        content: (
          <Typography.Paragraph copyable={{ text: password }}>
            {user.displayName} 的新初始密码：{password}
            <br />
            该员工已被退出登录，下次登录需要修改密码。
          </Typography.Paragraph>
        ),
      });
    },
  });

  return (
    <Modal
      open
      title={`重置密码：${user.displayName}`}
      okText="重置"
      okButtonProps={{ disabled: !valid }}
      confirmLoading={reset.isPending}
      onOk={() => reset.mutate()}
      onCancel={onClose}
    >
      <Space.Compact style={{ width: '100%' }}>
        <Input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          status={valid ? '' : 'error'}
        />
        <Button onClick={() => setPassword(randomPassword())}>随机生成</Button>
      </Space.Compact>
      <Typography.Text type={valid ? 'secondary' : 'danger'} style={{ fontSize: 12 }}>
        {PASSWORD_RULE.message}
      </Typography.Text>
    </Modal>
  );
}
