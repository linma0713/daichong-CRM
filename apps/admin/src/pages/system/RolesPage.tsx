import { useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Drawer,
  Form,
  Input,
  Radio,
  Row,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  type TableColumnsType,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ALL_PERMISSIONS, DATA_SCOPE_LABELS, type DataScope } from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { queryKeys, usePermissionCatalog, useRoles } from '../../api/queries';
import { useAuth } from '../../auth/AuthProvider';

type Role = Schemas['RoleDto'];
type PermissionGroup = Schemas['PermissionGroupDto'];

interface RoleForm {
  code: string;
  name: string;
  description?: string;
  dataScope: DataScope;
  permissions: string[];
}

export function RolesPage() {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = can('system:role:write');
  const roles = useRoles();
  const [editing, setEditing] = useState<Role | 'new' | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE('/api/roles/{id}', { params: { path: { id } } })),
    onSuccess: () => {
      message.success('已删除');
      void queryClient.invalidateQueries({ queryKey: queryKeys.roles });
    },
  });

  const columns: TableColumnsType<Role> = [
    {
      title: '角色',
      key: 'name',
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <Typography.Text strong>{r.name}</Typography.Text>
            {r.builtIn && <Tag>内置</Tag>}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {r.description || r.code}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '权限',
      key: 'permissions',
      render: (_, r) =>
        r.permissions.includes(ALL_PERMISSIONS) ? (
          <Tag color="gold">全部权限</Tag>
        ) : (
          `${r.permissions.length} 项`
        ),
    },
    { title: '数据范围', key: 'dataScope', render: (_, r) => DATA_SCOPE_LABELS[r.dataScope] },
    { title: '员工数', dataIndex: 'userCount' },
  ];

  columns.push({
    title: '操作',
    key: 'actions',
    render: (_, r) => {
      if (!canWrite) {
        return (
          <Button type="link" size="small" onClick={() => setEditing(r)}>
            查看
          </Button>
        );
      }
      const deleteBlocked = r.builtIn
        ? '内置角色不能删除'
        : r.userCount > 0
          ? '还有员工在使用这个角色'
          : null;
      return (
        <Space size={0}>
          <Button type="link" size="small" onClick={() => setEditing(r)}>
            编辑
          </Button>
          <Tooltip title={deleteBlocked}>
            <Button
              type="link"
              size="small"
              danger
              disabled={Boolean(deleteBlocked)}
              onClick={() =>
                modal.confirm({
                  title: `删除角色「${r.name}」？`,
                  okText: '删除',
                  okButtonProps: { danger: true },
                  onOk: () => remove.mutateAsync(r.id),
                })
              }
            >
              删除
            </Button>
          </Tooltip>
        </Space>
      );
    },
  });

  return (
    <Card
      title="角色与权限"
      extra={
        canWrite && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
            新增角色
          </Button>
        )
      }
    >
      <Typography.Paragraph type="secondary">
        一个员工可以有多个角色，权限取并集、数据范围取最大的那个。小团队可以让一个人同时担任客服和充值员。
      </Typography.Paragraph>
      <Table<Role>
        rowKey="id"
        columns={columns}
        dataSource={roles.data}
        loading={roles.isFetching}
        pagination={false}
        scroll={{ x: 640 }}
      />
      {editing && (
        <RoleDrawer
          role={editing === 'new' ? null : editing}
          readOnly={!canWrite}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function RoleDrawer({
  role,
  readOnly,
  onClose,
}: {
  role: Role | null;
  readOnly: boolean;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const catalog = usePermissionCatalog();
  const [form] = Form.useForm<RoleForm>();
  const isNew = role === null;
  const isAdmin = role?.permissions.includes(ALL_PERMISSIONS) ?? false;

  const save = useMutation({
    mutationFn: (v: RoleForm) =>
      isNew
        ? unwrap(api.POST('/api/roles', { body: v }))
        : unwrap(
            api.PATCH('/api/roles/{id}', {
              params: { path: { id: role.id } },
              body: isAdmin
                ? { name: v.name, description: v.description }
                : {
                    name: v.name,
                    description: v.description,
                    dataScope: v.dataScope,
                    permissions: v.permissions,
                  },
            }),
          ),
    onSuccess: () => {
      message.success('已保存，相关员工刷新页面后生效');
      void queryClient.invalidateQueries({ queryKey: queryKeys.roles });
      onClose();
    },
  });

  return (
    <Drawer
      open
      width={640}
      title={isNew ? '新增角色' : `${readOnly ? '查看' : '编辑'}角色：${role.name}`}
      onClose={onClose}
      destroyOnHidden
      extra={
        !readOnly && (
          <Button type="primary" loading={save.isPending} onClick={() => form.submit()}>
            保存
          </Button>
        )
      }
    >
      <Form<RoleForm>
        form={form}
        layout="vertical"
        disabled={readOnly}
        initialValues={
          isNew
            ? { dataScope: 'SELF', permissions: [] }
            : {
                code: role.code,
                name: role.name,
                description: role.description ?? undefined,
                dataScope: role.dataScope,
                permissions: role.permissions,
              }
        }
        onFinish={(v) => save.mutate(v)}
      >
        <Row gutter={12}>
          <Col xs={24} sm={12}>
            <Form.Item
              name="name"
              label="角色名称"
              rules={[{ required: true, message: '请输入角色名称' }]}
            >
              <Input maxLength={32} placeholder="例如：资深客服" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item
              name="code"
              label="角色编码"
              rules={[
                { required: true, message: '请输入角色编码' },
                {
                  pattern: /^[a-z][a-z0-9_]{1,31}$/,
                  message: '2–32 位小写字母、数字或下划线，字母开头',
                },
              ]}
            >
              <Input disabled={!isNew} placeholder="例如：senior_sales" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="description" label="说明">
          <Input.TextArea rows={2} maxLength={200} placeholder="这个角色负责什么" />
        </Form.Item>

        {isAdmin ? (
          <Alert
            type="warning"
            showIcon
            message="管理员角色固定拥有全部权限和全部数据范围，不能修改，以免没人能管理系统。"
          />
        ) : (
          <>
            <Form.Item name="dataScope" label="数据范围" extra="决定能看到哪些客户、订单等业务数据">
              <Radio.Group
                options={(catalog.data?.dataScopes ?? []).map((d) => ({
                  value: d.value,
                  label: d.label,
                }))}
              />
            </Form.Item>
            <Form.Item name="permissions" label="功能权限">
              <PermissionPicker groups={catalog.data?.groups ?? []} disabled={readOnly} />
            </Form.Item>
          </>
        )}
      </Form>
    </Drawer>
  );
}

/** 按模块分组的权限勾选框；后续模块的权限可以提前勾选 */
function PermissionPicker({
  groups,
  value = [],
  onChange,
  disabled,
}: {
  groups: PermissionGroup[];
  value?: string[];
  onChange?: (v: string[]) => void;
  disabled?: boolean;
}) {
  const selected = new Set(value);
  const toggle = (codes: string[], on: boolean) => {
    const next = new Set(selected);
    for (const c of codes) {
      if (on) next.add(c);
      else next.delete(c);
    }
    onChange?.([...next].sort());
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      {groups.map((g) => {
        const codes = g.permissions.map((p) => p.code);
        const count = codes.filter((c) => selected.has(c)).length;
        return (
          <Card
            key={g.key}
            size="small"
            title={
              <Checkbox
                checked={count === codes.length}
                indeterminate={count > 0 && count < codes.length}
                disabled={disabled}
                onChange={(e) => toggle(codes, e.target.checked)}
              >
                {g.name}
              </Checkbox>
            }
            extra={!g.available && <Tag color="default">后续模块</Tag>}
          >
            <Space wrap size={[16, 8]}>
              {g.permissions.map((p) => (
                <Checkbox
                  key={p.code}
                  checked={selected.has(p.code)}
                  disabled={disabled}
                  onChange={(e) => toggle([p.code], e.target.checked)}
                >
                  {p.name}
                </Checkbox>
              ))}
            </Space>
          </Card>
        );
      })}
    </Space>
  );
}
