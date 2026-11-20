import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  type TableColumnsType,
  type TablePaginationConfig,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  FULFILLMENT_TYPE_LABELS,
  FULFILLMENT_TYPES,
  SUBSCRIPTION_STATUS_LABELS,
  SUBSCRIPTION_STATUSES,
  type FulfillmentType,
  type SubscriptionStatus,
} from '@crm/shared';
import { api, unwrap, type QueryOf, type Schemas } from '../../api/client';
import { useBusinessSettings, useStaffOptions } from '../../api/queries';
import { useAuth } from '../../auth/AuthProvider';
import {
  AccountSecretButton,
  CustomerLink,
  DaysLeft,
  FulfillmentTag,
  SubscriptionStatusTag,
} from '../../components/business';
import { formatTime } from '../../components/format';

type Subscription = Schemas['SubscriptionDto'];
type SubQuery = QueryOf<'/api/subscriptions'>;

type View = 'remind' | 'expiring' | 'all';

interface Filters {
  page: number;
  pageSize: number;
  keyword?: string;
  status?: SubscriptionStatus;
  fulfillmentType?: FulfillmentType;
  ownerId?: string;
}

export function SubscriptionsPage() {
  const { profile, can } = useAuth();
  const settings = useBusinessSettings();
  const staff = useStaffOptions();
  // 客服默认看「需要提醒」，充值员 / 管理员默认看「即将到期」
  const [view, setView] = useState<View>(can('customer:write') ? 'remind' : 'expiring');
  const [filters, setFilters] = useState<Filters>({ page: 1, pageSize: 20 });
  const query: SubQuery = {
    ...filters,
    needsReminder: view === 'remind' ? true : undefined,
    expiringDays: view === 'expiring' ? 7 : undefined,
  };
  const subs = useQuery({
    queryKey: ['subscriptions', query],
    queryFn: () => unwrap(api.GET('/api/subscriptions', { params: { query } })),
    placeholderData: keepPreviousData,
  });

  return (
    <Card title="订阅与到期">
      <Tabs
        activeKey={view}
        onChange={(k) => {
          setView(k as View);
          setFilters((f) => ({ ...f, page: 1 }));
        }}
        items={[
          { key: 'remind', label: '需要提醒续费' },
          { key: 'expiring', label: '7 天内到期' },
          { key: 'all', label: '全部订阅' },
        ]}
      />
      {view === 'remind' && settings.data && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={`按设置的节奏（到期前 ${settings.data.reminderDays.join(' / ')} 天，以及到期后 7 天内）提醒客户续费。联系过客户后点「记录提醒」，这个阶段就不再提示；客户下了续费单也不再提示。`}
        />
      )}
      <div className="page-toolbar">
        <div className="page-toolbar-filters">
          <Input.Search
            placeholder="订阅编号、客户称呼、账号邮箱"
            allowClear
            style={{ width: 240 }}
            onSearch={(keyword) =>
              setFilters((f) => ({ ...f, page: 1, keyword: keyword || undefined }))
            }
          />
          {view === 'all' && (
            <Select
              placeholder="状态"
              allowClear
              style={{ width: 110 }}
              options={SUBSCRIPTION_STATUSES.map((s) => ({
                value: s,
                label: SUBSCRIPTION_STATUS_LABELS[s],
              }))}
              onChange={(status?: SubscriptionStatus) =>
                setFilters((f) => ({ ...f, page: 1, status }))
              }
            />
          )}
          <Select
            placeholder="履约方式"
            allowClear
            style={{ width: 110 }}
            options={FULFILLMENT_TYPES.map((t) => ({
              value: t,
              label: FULFILLMENT_TYPE_LABELS[t],
            }))}
            onChange={(fulfillmentType?: FulfillmentType) =>
              setFilters((f) => ({ ...f, page: 1, fulfillmentType }))
            }
          />
          {(profile?.dataScope !== 'SELF' || can('subscription:read')) && (
            <Select
              placeholder="负责客服"
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: 140 }}
              options={(staff.data ?? []).map((s) => ({ value: s.id, label: s.displayName }))}
              onChange={(ownerId?: string) => setFilters((f) => ({ ...f, page: 1, ownerId }))}
            />
          )}
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void subs.refetch()}>
          刷新
        </Button>
      </div>
      <SubscriptionTable
        data={subs.data?.items}
        loading={subs.isFetching}
        pagination={{
          current: filters.page,
          pageSize: filters.pageSize,
          total: subs.data?.total,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 个`,
          onChange: (page, pageSize) => setFilters((f) => ({ ...f, page, pageSize })),
        }}
      />
    </Card>
  );
}

/** 订阅表格：订阅页和客户详情页共用 */
export function SubscriptionTable({
  data,
  loading,
  pagination = false,
  hideCustomer = false,
}: {
  data?: Subscription[];
  loading?: boolean;
  pagination?: false | TablePaginationConfig;
  hideCustomer?: boolean;
}) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [reminding, setReminding] = useState<Subscription | null>(null);

  const columns: TableColumnsType<Subscription> = [
    {
      title: '订阅',
      key: 'code',
      render: (_, s) => (
        <Space direction="vertical" size={0}>
          <Link to={`/subscriptions/${s.id}`}>{s.code}</Link>
          <Space size={4}>
            <Typography.Text>{s.planName}</Typography.Text>
            <FulfillmentTag type={s.fulfillmentType} />
          </Space>
        </Space>
      ),
    },
    ...(hideCustomer
      ? []
      : [
          {
            title: '客户',
            key: 'customer',
            render: (_: unknown, s: Subscription) => <CustomerLink customer={s.customer} />,
          },
        ]),
    {
      title: 'Claude 账号',
      key: 'account',
      render: (_, s) => (
        <Space size={0}>
          <Typography.Text copyable={{ text: s.account.email }} style={{ fontSize: 13 }}>
            {s.account.email}
          </Typography.Text>
          <AccountSecretButton account={s.account} />
        </Space>
      ),
    },
    {
      title: '服务到期',
      key: 'endAt',
      render: (_, s) => (
        <Space direction="vertical" size={0}>
          <span>{formatTime(s.endAt)}</span>
          <Space size={4}>
            <SubscriptionStatusTag status={s.status} />
            {s.status !== 'CANCELLED' && <DaysLeft days={s.daysLeft} status={s.status} />}
          </Space>
        </Space>
      ),
    },
    {
      title: '上游扣费',
      key: 'upstream',
      render: (_, s) => (
        <Space direction="vertical" size={0}>
          <span>{formatTime(s.upstreamRenewAt)}</span>
          {s.autoRenewOn ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              自动续订开
            </Typography.Text>
          ) : (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              自动续订已关
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: '续费跟进',
      key: 'reminder',
      render: (_, s) => (
        <Space direction="vertical" size={0}>
          {s.openRenewalOrder ? (
            <Link to={`/orders/${s.openRenewalOrder.id}`}>
              <Tag color="purple">续费单 {s.openRenewalOrder.code}</Tag>
            </Link>
          ) : s.needsReminder ? (
            <Tag color="red">待提醒</Tag>
          ) : null}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {s.lastRemindedAt ? `上次提醒 ${formatTime(s.lastRemindedAt)}` : '还没提醒过'}
          </Typography.Text>
        </Space>
      ),
    },
    { title: '负责客服', key: 'owner', render: (_, s) => s.owner.displayName },
    {
      title: '操作',
      key: 'actions',
      fixed: 'right',
      render: (_, s) => (
        <Space size={0} wrap>
          {can('customer:write') && s.status !== 'CANCELLED' && (
            <Button type="link" size="small" onClick={() => setReminding(s)}>
              记录提醒
            </Button>
          )}
          {can('order:write') && s.status !== 'CANCELLED' && !s.openRenewalOrder && (
            <Tooltip title="为这个订阅录入续费订单">
              <Button
                type="link"
                size="small"
                onClick={() =>
                  navigate(
                    `/orders/new?kind=RENEWAL&customerId=${s.customer.id}&subscriptionId=${s.id}`,
                  )
                }
              >
                续费下单
              </Button>
            </Tooltip>
          )}
        </Space>
      ),
    },
  ];

  return (
    <>
      <Table<Subscription>
        rowKey="id"
        size={hideCustomer ? 'small' : undefined}
        columns={columns}
        dataSource={data}
        loading={loading}
        scroll={{ x: 1100 }}
        pagination={pagination}
      />
      {reminding && <ReminderModal subscription={reminding} onClose={() => setReminding(null)} />}
    </>
  );
}

/** 记录一次续费提醒（写进客户跟进记录） */
export function ReminderModal({
  subscription,
  onClose,
}: {
  subscription: Pick<Subscription, 'id' | 'code' | 'customer' | 'endAt' | 'planName'>;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<{ content: string }>();
  const save = useMutation({
    mutationFn: (content: string) =>
      unwrap(
        api.POST('/api/customers/{id}/follow-ups', {
          params: { path: { id: subscription.customer.id } },
          body: { content, subscriptionId: subscription.id, kind: 'renewal_reminder' },
        }),
      ),
    onSuccess: () => {
      message.success('已记录');
      void queryClient.invalidateQueries({ queryKey: ['subscriptions'] });
      void queryClient.invalidateQueries({ queryKey: ['subscription'] });
      void queryClient.invalidateQueries({ queryKey: ['customer'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`记录续费提醒：${subscription.customer.name} · ${subscription.code}`}
      okText="保存"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Typography.Paragraph type="secondary">
        {subscription.planName}，{formatTime(subscription.endAt)} 到期
      </Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v.content)}>
        <Form.Item
          name="content"
          label="沟通情况"
          rules={[{ required: true, message: '请填写沟通情况' }]}
        >
          <Input.TextArea
            rows={3}
            maxLength={1000}
            placeholder="例如：已微信提醒，客户说周末付款"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
