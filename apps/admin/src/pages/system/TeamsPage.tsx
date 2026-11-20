import { useState } from 'react';
import {
  App,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Space,
  Table,
  Tooltip,
  Typography,
  type TableColumnsType,
} from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, unwrap, type Schemas } from '../../api/client';
import { queryKeys, useTeams } from '../../api/queries';
import { useAuth } from '../../auth/AuthProvider';

type Team = Schemas['TeamDto'];

export function TeamsPage() {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = can('system:team:write');
  const teams = useTeams();
  const [editing, setEditing] = useState<Team | 'new' | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.teams });
    void queryClient.invalidateQueries({ queryKey: queryKeys.users() });
  };

  const remove = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE('/api/teams/{id}', { params: { path: { id } } })),
    onSuccess: () => {
      message.success('已删除');
      invalidate();
    },
  });

  const columns: TableColumnsType<Team> = [
    { title: '小组名称', dataIndex: 'name' },
    { title: '员工数', dataIndex: 'userCount' },
  ];
  if (canWrite) {
    columns.push({
      title: '操作',
      key: 'actions',
      render: (_, t) => (
        <Space size={0}>
          <Button type="link" size="small" onClick={() => setEditing(t)}>
            改名
          </Button>
          <Tooltip
            title={
              t.userCount > 0 ? '小组里还有员工，请先在「员工」页把这些员工调到其他小组' : null
            }
          >
            <Button
              type="link"
              size="small"
              danger
              disabled={t.userCount > 0}
              onClick={() =>
                modal.confirm({
                  title: `删除小组「${t.name}」？`,
                  okText: '删除',
                  okButtonProps: { danger: true },
                  onOk: () => remove.mutateAsync(t.id),
                })
              }
            >
              删除
            </Button>
          </Tooltip>
        </Space>
      ),
    });
  }

  return (
    <Card
      title="小组"
      extra={
        canWrite && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
            新增小组
          </Button>
        )
      }
    >
      <Typography.Paragraph type="secondary">
        {'小组用于划分数据范围：角色的数据范围设为「本小组的数据」时，员工只能看到同组同事负责的客户和订单。' +
          '人少时可以不建小组。'}
      </Typography.Paragraph>
      <Table<Team>
        rowKey="id"
        columns={columns}
        dataSource={teams.data}
        loading={teams.isFetching}
        pagination={false}
        locale={{ emptyText: '还没有小组' }}
      />
      {editing && (
        <TeamModal
          team={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={invalidate}
        />
      )}
    </Card>
  );
}

function TeamModal({
  team,
  onClose,
  onSaved,
}: {
  team: Team | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ name: string }>();
  const save = useMutation({
    mutationFn: ({ name }: { name: string }) =>
      team
        ? unwrap(
            api.PATCH('/api/teams/{id}', { params: { path: { id: team.id } }, body: { name } }),
          )
        : unwrap(api.POST('/api/teams', { body: { name } })),
    onSuccess: () => {
      message.success('已保存');
      onSaved();
      onClose();
    },
  });

  return (
    <Modal
      open
      title={team ? '修改小组名称' : '新增小组'}
      okText="保存"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
      destroyOnHidden
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ name: team?.name }}
        onFinish={(v) => save.mutate({ name: v.name.trim() })}
      >
        <Form.Item
          name="name"
          label="小组名称"
          rules={[{ required: true, whitespace: true, message: '请输入小组名称' }]}
        >
          <Input maxLength={32} placeholder="例如：客服一组" autoFocus />
        </Form.Item>
      </Form>
    </Modal>
  );
}
