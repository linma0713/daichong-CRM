import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Form,
  Input,
  Modal,
  Result,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import {
  SUBSCRIPTION_STATUS_LABELS,
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
} from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import {
  AccountSecretButton,
  CustomerLink,
  DaysLeft,
  FulfillmentTag,
  Money,
  OrderKindTag,
  OrderStatusTag,
  SubscriptionStatusTag,
  TaskStatusTag,
  TaskTypeTag,
  TicketStatusTag,
  TicketTypeTag,
  WarrantyAlert,
} from '../../components/business';
import { formatTime } from '../../components/format';
import { NewTicketModal } from '../aftersales/modals';
import { ReminderModal } from './SubscriptionsPage';

type Detail = Schemas['SubscriptionDetailDto'];

export function SubscriptionDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [reminding, setReminding] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [editingAccount, setEditingAccount] = useState(false);
  const [ticketing, setTicketing] = useState(false);
  const sub = useQuery({
    queryKey: ['subscription', id],
    queryFn: () => unwrap(api.GET('/api/subscriptions/{id}', { params: { path: { id } } })),
  });

  if (sub.isLoading) return <Spin style={{ display: 'block', margin: 48 }} />;
  if (!sub.data) return <Result status="404" title="订阅不存在或你没有权限查看" />;
  const s = sub.data;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            订阅 {s.code}
            <SubscriptionStatusTag status={s.status} />
            <DaysLeft days={s.daysLeft} status={s.status} />
          </Space>
        }
        extra={
          <Space wrap>
            {can('order:write') && s.status !== 'CANCELLED' && !s.openRenewalOrder && (
              <Button
                type="primary"
                onClick={() =>
                  navigate(
                    `/orders/new?kind=RENEWAL&customerId=${s.customer.id}&subscriptionId=${s.id}`,
                  )
                }
              >
                续费下单
              </Button>
            )}
            {can('customer:write') && s.status !== 'CANCELLED' && (
              <Button onClick={() => setReminding(true)}>记录提醒</Button>
            )}
            {(can('ticket:create') || can('ticket:handle')) && (
              <Button onClick={() => setTicketing(true)}>登记售后</Button>
            )}
            {can('fulfillment:handle') && (
              <Button onClick={() => setCorrecting(true)}>手动校正</Button>
            )}
          </Space>
        }
      >
        {s.needsReminder && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message="快到期了，还没提醒客户续费"
          />
        )}
        {s.openRenewalOrder && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message={
              <>
                有未完成的续费订单{' '}
                <Link to={`/orders/${s.openRenewalOrder.id}`}>{s.openRenewalOrder.code}</Link>
              </>
            }
          />
        )}
        <Descriptions column={{ xs: 1, md: 2 }} size="small">
          <Descriptions.Item label="客户">
            <CustomerLink customer={s.customer} />
          </Descriptions.Item>
          <Descriptions.Item label="套餐">
            <Space size={4}>
              {s.planName}
              <FulfillmentTag type={s.fulfillmentType} />
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="Claude 账号">
            <Space size={0}>
              <Typography.Text copyable>{s.account.email}</Typography.Text>
              <AccountSecretButton account={s.account} />
              {(can('fulfillment:handle') || can('customer:write')) && (
                <Button type="link" size="small" onClick={() => setEditingAccount(true)}>
                  修改密码
                </Button>
              )}
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="负责客服">{s.owner.displayName}</Descriptions.Item>
          <Descriptions.Item label="服务期">
            {formatTime(s.startAt)} ~ {formatTime(s.endAt)}
          </Descriptions.Item>
          <Descriptions.Item label="上游下次扣费">
            {formatTime(s.upstreamRenewAt)}
            <Typography.Text
              type={s.autoRenewOn ? 'secondary' : 'warning'}
              style={{ marginLeft: 8 }}
            >
              {s.autoRenewOn ? '自动续订开' : '自动续订已关'}
            </Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="上次提醒">{formatTime(s.lastRemindedAt)}</Descriptions.Item>
        </Descriptions>
        {s.status === 'ACTIVE' && (
          <div style={{ marginTop: 16 }}>
            <WarrantyAlert warranty={s.warranty} title="质保（按现在）" />
          </div>
        )}
      </Card>

      {s.tickets.length > 0 && (
        <Card title="售后工单" size="small">
          <Table<Schemas['SubscriptionTicketDto']>
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={s.tickets}
            scroll={{ x: 560 }}
            columns={[
              {
                title: '工单',
                key: 'code',
                render: (_, t) =>
                  can('ticket:create') || can('ticket:handle') ? (
                    <Link to={`/tickets/${t.id}`}>{t.code}</Link>
                  ) : (
                    t.code
                  ),
              },
              { title: '类型', key: 'type', render: (_, t) => <TicketTypeTag type={t.type} /> },
              {
                title: '状态',
                key: 'status',
                render: (_, t) => <TicketStatusTag status={t.status} />,
              },
              {
                title: '问题',
                key: 'description',
                render: (_, t) => (
                  <Typography.Text ellipsis style={{ maxWidth: 320 }}>
                    {t.description}
                  </Typography.Text>
                ),
              },
              { title: '登记', key: 'createdAt', render: (_, t) => formatTime(t.createdAt) },
            ]}
          />
        </Card>
      )}

      <Card title="订单" size="small">
        <Table<Schemas['SubscriptionOrderDto']>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={s.orders}
          scroll={{ x: 560 }}
          columns={[
            {
              title: '订单',
              key: 'code',
              render: (_, o) =>
                can('order:read') ? <Link to={`/orders/${o.id}`}>{o.code}</Link> : o.code,
            },
            {
              title: '商品',
              key: 'product',
              render: (_, o) => (
                <Space size={4}>
                  <OrderKindTag kind={o.kind} />
                  {o.productName}
                </Space>
              ),
            },
            {
              title: '金额',
              key: 'amount',
              render: (_, o) => (
                <Space size={4}>
                  <Money cents={o.amountCents} />
                  {o.withWarranty && <Tag color="green">含质保</Tag>}
                </Space>
              ),
            },
            {
              title: '状态',
              key: 'status',
              render: (_, o) => <OrderStatusTag status={o.status} />,
            },
            { title: '时间', key: 'createdAt', render: (_, o) => formatTime(o.createdAt) },
          ]}
        />
      </Card>

      <Card title="履约任务" size="small">
        <Table<Schemas['TaskBriefDto']>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={s.tasks}
          scroll={{ x: 640 }}
          columns={[
            { title: '任务', key: 'code', render: (_, t) => t.code },
            { title: '类型', key: 'type', render: (_, t) => <TaskTypeTag type={t.type} /> },
            { title: '状态', key: 'status', render: (_, t) => <TaskStatusTag status={t.status} /> },
            {
              title: '处理人',
              key: 'assignee',
              render: (_, t) => t.assignee?.displayName ?? '任务池',
            },
            { title: '最晚完成', key: 'dueAt', render: (_, t) => formatTime(t.dueAt) },
            { title: '备注', key: 'note', render: (_, t) => t.note ?? '—' },
          ]}
        />
      </Card>

      <Card title="续费提醒记录" size="small">
        <Table<Schemas['FollowUpDto']>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={s.reminders}
          locale={{ emptyText: '还没有提醒记录' }}
          columns={[
            {
              title: '时间',
              key: 'createdAt',
              width: 160,
              render: (_, f) => formatTime(f.createdAt),
            },
            { title: '客服', key: 'user', width: 100, render: (_, f) => f.user.displayName },
            { title: '内容', key: 'content', render: (_, f) => f.content },
          ]}
        />
      </Card>

      {reminding && <ReminderModal subscription={s} onClose={() => setReminding(false)} />}
      {correcting && <CorrectModal sub={s} onClose={() => setCorrecting(false)} />}
      {editingAccount && <AccountModal sub={s} onClose={() => setEditingAccount(false)} />}
      {ticketing && (
        <NewTicketModal
          customer={{ id: s.customer.id, label: `${s.customer.name}（${s.customer.code}）` }}
          subscriptionId={s.id}
          onClose={() => setTicketing(false)}
          onCreated={(ticketId) => void navigate(`/tickets/${ticketId}`)}
        />
      )}
    </Space>
  );
}

interface CorrectForm {
  endAt: Dayjs;
  upstreamRenewAt?: Dayjs | null;
  autoRenewOn: boolean;
  status: SubscriptionStatus;
  reason: string;
}

function CorrectModal({ sub, onClose }: { sub: Detail; onClose: () => void }) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<CorrectForm>();
  const save = useMutation({
    mutationFn: (v: CorrectForm) =>
      unwrap(
        api.PATCH('/api/subscriptions/{id}', {
          params: { path: { id: sub.id } },
          body: {
            endAt: v.endAt.toISOString(),
            upstreamRenewAt: v.upstreamRenewAt ? v.upstreamRenewAt.toISOString() : null,
            autoRenewOn: v.autoRenewOn,
            status: v.status,
            reason: v.reason,
          },
        }),
      ),
    onSuccess: () => {
      message.success('已保存');
      void queryClient.invalidateQueries({ queryKey: ['subscription', sub.id] });
      void queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`手动校正：${sub.code}`}
      okText="保存"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Typography.Paragraph type="secondary">
        系统按开通 / 续费自动计算这些时间。只在和上游实际情况对不上时修改，修改会记入操作日志。
      </Typography.Paragraph>
      <Form<CorrectForm>
        form={form}
        layout="vertical"
        initialValues={{
          endAt: dayjs(sub.endAt),
          upstreamRenewAt: sub.upstreamRenewAt ? dayjs(sub.upstreamRenewAt) : null,
          autoRenewOn: sub.autoRenewOn,
          status: sub.status,
        }}
        onFinish={(v) => save.mutate(v)}
      >
        <Form.Item name="endAt" label="服务到期时间" rules={[{ required: true }]}>
          <DatePicker showTime style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="upstreamRenewAt" label="上游下次扣费时间">
          <DatePicker showTime style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="autoRenewOn" label="上游自动续订开着" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item
          name="status"
          label="状态"
          extra="改为「已终止」会一并作废这个订阅未完成的内部续费 / 取消续订 / 回收任务"
        >
          <Select
            options={SUBSCRIPTION_STATUSES.map((st) => ({
              value: st,
              label: SUBSCRIPTION_STATUS_LABELS[st],
            }))}
          />
        </Form.Item>
        <Form.Item
          name="reason"
          label="修改原因"
          rules={[{ required: true, message: '请填写修改原因' }]}
        >
          <Input maxLength={200} placeholder="例如：上游实际扣费日是 12 月 3 日" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function AccountModal({ sub, onClose }: { sub: Detail; onClose: () => void }) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<{ password?: string; secretNote?: string }>();
  const save = useMutation({
    mutationFn: (v: { password?: string; secretNote?: string }) =>
      unwrap(
        api.PATCH('/api/accounts/{id}', {
          params: { path: { id: sub.account.id } },
          body: {
            ...(v.password ? { password: v.password } : {}),
            ...(v.secretNote ? { secretNote: v.secretNote } : {}),
          },
        }),
      ),
    onSuccess: () => {
      message.success('已保存');
      void queryClient.invalidateQueries({ queryKey: ['subscription', sub.id] });
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`修改账号信息：${sub.account.email}`}
      okText="保存"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <Form.Item name="password" label="新密码" extra="不填则不改；加密保存">
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="secretNote" label="其他敏感信息" extra="恢复邮箱、备用码等；不填则不改">
          <Input.TextArea rows={2} maxLength={1000} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
