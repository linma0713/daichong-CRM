import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Alert,
  App,
  Badge,
  Button,
  Card,
  Checkbox,
  DatePicker,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  type TableColumnsType,
  type TablePaginationConfig,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import { TASK_TYPE_LABELS, TASK_TYPES, formatCents, type TaskType } from '@crm/shared';
import { api, unwrap, type QueryOf, type Schemas } from '../../api/client';
import { useResources, useStaffOptions } from '../../api/queries';
import { useAuth } from '../../auth/AuthProvider';
import {
  AccountSecretButton,
  CustomerLink,
  FulfillmentTag,
  TaskStatusTag,
  TaskTypeTag,
} from '../../components/business';
import { formatTime } from '../../components/format';
import { NOTIFY_KEYS } from '../../components/notify';

type Task = Schemas['TaskDto'];
type View = 'mine' | 'pool' | 'open' | 'overdue' | 'closed';
type Filters = QueryOf<'/api/tasks'> & { page: number; pageSize: number };

const VIEW_QUERY: Record<View, Partial<Filters>> = {
  mine: { view: 'open', assignee: 'me' },
  pool: { view: 'open', assignee: 'unassigned' },
  open: { view: 'open' },
  overdue: { view: 'open', overdue: true },
  closed: { view: 'closed' },
};

/** 每类任务要做什么，显示在完成弹窗里 */
const TASK_GUIDE: Record<TaskType, string> = {
  ACTIVATE: '为客户开通订阅',
  RENEW: '客户已付款续费：为这个订阅续上服务（上游如已停止自动续订，需要重新订阅）',
  INTERNAL_RENEW: '客户买的是季付 / 年付，上游按月扣费：确认这次上游扣费成功（付款资源余额充足）',
  CANCEL_AUTO_RENEW:
    '客户付费的服务期快结束且还没续费：在上游下次扣费前取消自动续订，避免替客户垫付',
  RECLAIM_ACCOUNT: '成品号到期未续费：收回账号（建议修改密码），之后可以再卖给其他客户',
  REPLACE_ACCOUNT:
    '售后换号：给客户换一个能用的账号，服务期不变。成品号从库存选新号；代充换成客户提供的新账号，一般要重新付费',
};

const VIEWS = Object.keys(VIEW_QUERY) as View[];

/** 在班情况：谁在班、手上有几个没做完的任务 */
function DutyBar() {
  const duty = useQuery({
    queryKey: NOTIFY_KEYS.duty,
    queryFn: () => unwrap(api.GET('/api/tasks/duty')),
    refetchInterval: 60_000,
  });
  const staff = duty.data?.staff ?? [];
  if (staff.length === 0) return null;
  const on = staff.filter((s) => s.onDuty);
  const off = staff.filter((s) => !s.onDuty);
  const name = (s: (typeof staff)[number]) => `${s.displayName}${s.open ? `（${s.open}）` : ''}`;
  return (
    <Typography.Paragraph type="secondary" style={{ marginTop: -4 }}>
      {on.length > 0 ? (
        <>
          <Badge status="success" text={`在班：${on.map(name).join('、')}`} />
          {off.length > 0 && (
            <span style={{ marginLeft: 16 }}>休息：{off.map(name).join('、')}</span>
          )}
          <span style={{ marginLeft: 16 }}>
            新任务只派给在班的人，手上任务少的优先，一样多就轮流
          </span>
        </>
      ) : (
        <>
          <Badge status="default" text="现在没人在班" />
          <span style={{ marginLeft: 16 }}>
            新任务在所有充值员（{staff.map(name).join('、')}
            ）之间派。充值员在右上角打开「在班」后，只派给在班的人
          </span>
        </>
      )}
    </Typography.Paragraph>
  );
}

export function TasksPage() {
  const [params] = useSearchParams();
  const urlView = params.get('view') as View | null;
  const urlKeyword = params.get('keyword') ?? undefined;
  const [view, setView] = useState<View>(
    urlView && VIEWS.includes(urlView) ? urlView : urlKeyword ? 'open' : 'mine',
  );
  const [filters, setFilters] = useState<{
    page: number;
    pageSize: number;
    type?: TaskType;
    keyword?: string;
  }>({
    page: 1,
    pageSize: 20,
    keyword: urlKeyword,
  });
  // 从消息里点进来时（例如 ?view=open&keyword=T00012）定位到那个任务
  useEffect(() => {
    if (urlView && VIEWS.includes(urlView)) setView(urlView);
    if (urlKeyword !== undefined) setFilters((f) => ({ ...f, page: 1, keyword: urlKeyword }));
  }, [urlView, urlKeyword]);
  const query: Filters = { ...filters, ...VIEW_QUERY[view] };
  const tasks = useQuery({
    queryKey: ['tasks', query],
    queryFn: () => unwrap(api.GET('/api/tasks', { params: { query } })),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const dashboard = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => unwrap(api.GET('/api/dashboard')),
  });
  const stats = dashboard.data?.tasks;

  const label = (text: string, count?: number, danger = false) => (
    <Space size={6}>
      {text}
      {count ? <Badge count={count} color={danger ? 'red' : 'blue'} /> : null}
    </Space>
  );

  return (
    <Card title="任务工作台">
      <Tabs
        activeKey={view}
        onChange={(k) => {
          setView(k as View);
          setFilters((f) => ({ ...f, page: 1 }));
        }}
        items={[
          { key: 'mine', label: label('我的待办', stats?.mine) },
          { key: 'pool', label: label('任务池', stats?.unassigned) },
          { key: 'open', label: label('全部未完成', stats?.open) },
          { key: 'overdue', label: label('已超时', stats?.overdue, true) },
          { key: 'closed', label: '已结束' },
        ]}
      />
      <DutyBar />
      <div className="page-toolbar">
        <div className="page-toolbar-filters">
          <Input.Search
            key={urlKeyword ?? ''}
            defaultValue={urlKeyword}
            placeholder="任务编号、客户称呼、账号邮箱"
            allowClear
            style={{ width: 240 }}
            onSearch={(keyword) =>
              setFilters((f) => ({ ...f, page: 1, keyword: keyword || undefined }))
            }
          />
          <Select
            placeholder="任务类型"
            allowClear
            style={{ width: 140 }}
            options={TASK_TYPES.map((t) => ({ value: t, label: TASK_TYPE_LABELS[t] }))}
            onChange={(type?: TaskType) => setFilters((f) => ({ ...f, page: 1, type }))}
          />
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void tasks.refetch()}>
          刷新
        </Button>
      </div>
      <TaskTable
        data={tasks.data?.items}
        loading={tasks.isFetching}
        pagination={{
          current: filters.page,
          pageSize: filters.pageSize,
          total: tasks.data?.total,
          showSizeChanger: true,
          showTotal: (total: number) => `共 ${total} 个`,
          onChange: (page: number, pageSize: number) =>
            setFilters((f) => ({ ...f, page, pageSize })),
        }}
      />
    </Card>
  );
}

function TaskTable({
  data,
  loading,
  pagination,
}: {
  data?: Task[];
  loading?: boolean;
  pagination: TablePaginationConfig;
}) {
  const { profile } = useAuth();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [completing, setCompleting] = useState<Task | null>(null);
  const [noting, setNoting] = useState<{ task: Task; action: 'fail' | 'cancel' } | null>(null);
  const [assigning, setAssigning] = useState<Task | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const claim = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.POST('/api/tasks/{id}/claim', { params: { path: { id } } })),
    onSuccess: () => {
      message.success('已开始处理');
      refresh();
    },
  });

  const columns: TableColumnsType<Task> = [
    {
      title: '任务',
      key: 'code',
      render: (_, t) => (
        <Space direction="vertical" size={2}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t.code}
          </Typography.Text>
          <Space size={4}>
            <TaskTypeTag type={t.type} />
            <FulfillmentTag type={t.fulfillmentType} />
          </Space>
        </Space>
      ),
    },
    {
      title: '客户',
      key: 'customer',
      width: 150,
      render: (_, t) => <CustomerLink customer={t.customer} />,
    },
    {
      title: '内容',
      key: 'content',
      width: 300,
      render: (_, t) => (
        <Space direction="vertical" size={0} style={{ fontSize: 13 }}>
          {t.order && (
            <span>
              <Link to={`/orders/${t.order.id}`}>{t.order.code}</Link> {t.order.productName}
            </span>
          )}
          {t.subscription && (
            <span>
              <Link to={`/subscriptions/${t.subscription.id}`}>{t.subscription.code}</Link>{' '}
              {t.subscription.planName} · 服务到 {formatTime(t.subscription.endAt).slice(0, 10)}
            </span>
          )}
          {t.account ? (
            <Space size={0}>
              <Typography.Text copyable={{ text: t.account.email }}>
                {t.account.email}
              </Typography.Text>
              <AccountSecretButton account={t.account} />
            </Space>
          ) : (
            <Typography.Text type="secondary">成品号待分配</Typography.Text>
          )}
          {t.ticket && (
            <Typography.Text type="warning">
              售后 {t.ticket.code}：{t.ticket.description}
            </Typography.Text>
          )}
          {t.subscription?.upstreamRenewAt &&
            (t.type === 'INTERNAL_RENEW' || t.type === 'CANCEL_AUTO_RENEW') && (
              <Typography.Text type="warning">
                上游扣费：{formatTime(t.subscription.upstreamRenewAt)}
              </Typography.Text>
            )}
        </Space>
      ),
    },
    {
      title: '最晚完成',
      key: 'dueAt',
      render: (_, t) => (
        <Space direction="vertical" size={0}>
          <span>{formatTime(t.dueAt)}</span>
          {t.overdue && <Tag color="red">已超时</Tag>}
        </Space>
      ),
    },
    {
      title: '处理人',
      key: 'assignee',
      render: (_, t) => (
        <Space direction="vertical" size={0}>
          {t.assignee ? (
            t.assignee.displayName
          ) : (
            <Typography.Text type="secondary">任务池</Typography.Text>
          )}
          <TaskStatusTag status={t.status} />
          {t.attempts > 0 && (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              失败 {t.attempts} 次
            </Typography.Text>
          )}
          {t.note && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t.note}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      fixed: 'right',
      width: 150,
      render: (_, t) => {
        if (t.status === 'DONE' || t.status === 'CANCELLED') {
          return (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {formatTime(t.finishedAt)}
            </Typography.Text>
          );
        }
        const takenByOther =
          t.status === 'IN_PROGRESS' && t.assignee && t.assignee.id !== profile?.id;
        return (
          <Space size={0} wrap>
            {t.status !== 'IN_PROGRESS' && (
              <Button
                type="link"
                size="small"
                loading={claim.isPending}
                onClick={() => claim.mutate(t.id)}
              >
                开始处理
              </Button>
            )}
            {!takenByOther && (
              <Button type="link" size="small" onClick={() => setCompleting(t)}>
                完成
              </Button>
            )}
            {!takenByOther && (
              <Button
                type="link"
                size="small"
                danger
                onClick={() => setNoting({ task: t, action: 'fail' })}
              >
                失败
              </Button>
            )}
            <Button type="link" size="small" onClick={() => setAssigning(t)}>
              转交
            </Button>
            {(t.type === 'CANCEL_AUTO_RENEW' || t.type === 'RECLAIM_ACCOUNT') && (
              <Button
                type="link"
                size="small"
                onClick={() => setNoting({ task: t, action: 'cancel' })}
              >
                作废
              </Button>
            )}
          </Space>
        );
      },
    },
  ];

  return (
    <>
      <Table<Task>
        rowKey="id"
        columns={columns}
        dataSource={data}
        loading={loading}
        scroll={{ x: 1100 }}
        pagination={pagination}
        rowClassName={(t) => (t.overdue ? 'row-overdue' : '')}
      />
      {completing && (
        <CompleteModal task={completing} onClose={() => setCompleting(null)} onDone={refresh} />
      )}
      {noting && (
        <NoteModal
          task={noting.task}
          action={noting.action}
          onClose={() => setNoting(null)}
          onDone={refresh}
        />
      )}
      {assigning && (
        <AssignModal task={assigning} onClose={() => setAssigning(null)} onDone={refresh} />
      )}
    </>
  );
}

interface CompleteForm {
  note?: string;
  activatedAt?: Dayjs;
  upstreamRenewAt?: Dayjs;
  stockAccountId?: string;
  accountEmail?: string;
  accountPassword?: string;
  accountSecretNote?: string;
  resourceId?: string;
  chargeUsd?: number;
  noCharge?: boolean;
  reclaimTo?: 'STOCK' | 'VOID';
}

function CompleteModal({
  task,
  onClose,
  onDone,
}: {
  task: Task;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<CompleteForm>();
  const isActivate = task.type === 'ACTIVATE';
  const isReplace = task.type === 'REPLACE_ACCOUNT';
  const deliversAccount = (isActivate || isReplace) && task.fulfillmentType === 'ACCOUNT';
  const newCustomerAccount = isReplace && task.fulfillmentType === 'RECHARGE';
  const movesOldAccount =
    task.type === 'RECLAIM_ACCOUNT' || (isReplace && task.fulfillmentType === 'ACCOUNT');
  const resources = useResources(task.chargeMode !== 'none');
  const activeResources = resources.data?.filter((r) => r.active) ?? [];
  const stock = useQuery({
    queryKey: ['stock-accounts', { planId: task.planId, status: 'IN_STOCK', pageSize: 100 }],
    queryFn: () =>
      unwrap(
        api.GET('/api/stock-accounts', {
          params: {
            query: { planId: task.planId ?? undefined, status: 'IN_STOCK', pageSize: 100 },
          },
        }),
      ),
    enabled: deliversAccount && !!task.planId,
  });
  const stockItems = stock.data?.items ?? [];
  const [source, setSource] = useState<'stock' | 'manual' | null>(null);
  const accountSource = source ?? (stockItems.length ? 'stock' : 'manual');
  const noCharge = Form.useWatch('noCharge', form);
  const stockAccountId = Form.useWatch('stockAccountId', form);
  const pickedStock = stockItems.find((a) => a.id === stockAccountId);
  // 选的库存号已经过了上游付费日，要重新付费
  const stockLapsed =
    !!pickedStock?.upstreamRenewAt && dayjs(pickedStock.upstreamRenewAt).isBefore(dayjs());
  const chargeRequired = task.chargeMode === 'required' || stockLapsed;
  const defaultUsd = task.upstreamMonthlyUsdCents ? task.upstreamMonthlyUsdCents / 100 : undefined;
  const askUpstream =
    isActivate || isReplace || task.type === 'RENEW' || task.type === 'INTERNAL_RENEW';
  const upstreamHint: Record<string, string> = {
    REPLACE_ACCOUNT: '不填：这次登记了扣费 = 现在 + 1 个月；从库存发的号沿用号上的付费日',
    ACTIVATE: '不填 = 开通时间 + 1 个月',
    RENEW: '不填 = 保持原来的扣费时间（之前取消过自动续订的，默认现在 + 1 个月）',
    INTERNAL_RENEW: `不填 = 原扣费时间 + 1 个月${
      task.subscription?.upstreamRenewAt
        ? `（${dayjs(task.subscription.upstreamRenewAt).add(1, 'month').format('YYYY-MM-DD HH:mm')}）`
        : ''
    }`,
  };

  const complete = useMutation({
    mutationFn: (v: CompleteForm) =>
      unwrap(
        api.POST('/api/tasks/{id}/complete', {
          params: { path: { id: task.id } },
          body: {
            note: v.note || undefined,
            activatedAt: v.activatedAt?.toISOString(),
            upstreamRenewAt: v.upstreamRenewAt?.toISOString(),
            stockAccountId:
              deliversAccount && accountSource === 'stock' ? v.stockAccountId : undefined,
            accountEmail:
              deliversAccount && accountSource === 'stock'
                ? undefined
                : v.accountEmail?.trim() || undefined,
            accountPassword: v.accountPassword || undefined,
            accountSecretNote: v.accountSecretNote || undefined,
            resourceId: v.noCharge ? undefined : v.resourceId,
            chargeUsdCents:
              v.noCharge || !v.resourceId || v.chargeUsd === undefined || v.chargeUsd === null
                ? undefined
                : Math.round(v.chargeUsd * 100),
            noCharge: v.noCharge || undefined,
            reclaimTo: movesOldAccount ? v.reclaimTo : undefined,
          },
        }),
      ),
    onSuccess: (t) => {
      message.success(
        t.type === 'ACTIVATE' && t.subscription
          ? `已完成，订阅 ${t.subscription.code} 开始计时`
          : t.type === 'REPLACE_ACCOUNT'
            ? `已换号，${t.ticket?.code ?? '工单'} 自动标记为已解决`
            : '已完成',
      );
      for (const key of ['resources', 'stock-accounts', 'inventory-summary', 'tickets']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      onDone();
      onClose();
    },
  });

  return (
    <Modal
      open
      title={`完成任务：${TASK_TYPE_LABELS[task.type]} · ${task.customer.name}`}
      okText="确认完成"
      confirmLoading={complete.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
      width={560}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={TASK_GUIDE[task.type]}
        description={
          task.order
            ? `${task.order.code} ${task.order.productName}${task.account ? ` · ${task.account.email}` : ''}`
            : task.subscription
              ? `${task.subscription.code} ${task.subscription.planName}${task.account ? ` · ${task.account.email}` : ''}`
              : undefined
        }
      />
      <Form<CompleteForm>
        form={form}
        layout="vertical"
        initialValues={{ chargeUsd: defaultUsd, reclaimTo: isReplace ? 'VOID' : 'STOCK' }}
        onFinish={(v) => complete.mutate(v)}
      >
        {deliversAccount && (
          <>
            <Form.Item label="交付哪个号">
              <Radio.Group
                value={accountSource}
                onChange={(e) => setSource(e.target.value as 'stock' | 'manual')}
                options={[
                  {
                    value: 'stock',
                    label: `从库存选（在库 ${stockItems.length} 个）`,
                    disabled: stockItems.length === 0,
                  },
                  { value: 'manual', label: '手动登记一个新号' },
                ]}
              />
            </Form.Item>
            {accountSource === 'stock' ? (
              <Form.Item
                name="stockAccountId"
                label="库存成品号"
                initialValue={stockItems[0]?.id}
                rules={[{ required: true, message: '请选择要交付的成品号' }]}
                extra={
                  stockLapsed
                    ? '这个号的上游付费已过期，交付前要重新订阅，并在下面登记这次扣费'
                    : '按入库时间先进先出；备号成本会结转到这笔订单'
                }
              >
                <Select
                  loading={stock.isLoading}
                  options={stockItems.map((a) => ({
                    value: a.id,
                    label: `${a.email}（付费到 ${a.upstreamRenewAt ? dayjs(a.upstreamRenewAt).format('MM-DD') : '未付费'}）`,
                  }))}
                />
              </Form.Item>
            ) : (
              <>
                <Form.Item
                  name="accountEmail"
                  label="交付的成品号邮箱"
                  rules={[
                    { required: true, message: '请填写交付的账号' },
                    { type: 'email', message: '邮箱格式不正确' },
                  ]}
                >
                  <Input autoComplete="off" />
                </Form.Item>
                <Form.Item
                  name="accountPassword"
                  label="登录密码"
                  extra="新账号必填；回收再卖的旧账号不填则沿用原密码。加密保存。"
                >
                  <Input.Password autoComplete="new-password" />
                </Form.Item>
              </>
            )}
            <Form.Item
              name="accountSecretNote"
              label="其他敏感信息"
              extra="恢复邮箱、备用码等，加密保存；不填则不改"
            >
              <Input.TextArea rows={2} maxLength={1000} />
            </Form.Item>
          </>
        )}
        {isReplace && task.ticket && (
          <Typography.Paragraph type="secondary" style={{ marginTop: -4 }}>
            售后 {task.ticket.code}：{task.ticket.description}
          </Typography.Paragraph>
        )}
        {newCustomerAccount && (
          <>
            <Form.Item
              name="accountEmail"
              label="客户新的 Claude 账号邮箱"
              rules={[
                { required: true, message: '请填写客户新的账号' },
                { type: 'email', message: '邮箱格式不正确' },
              ]}
              extra="原账号如果还绑着我们的付款资源，记得顺手解绑"
            >
              <Input autoComplete="off" />
            </Form.Item>
            <Form.Item name="accountPassword" label="新账号密码" extra="可不填；加密保存">
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          </>
        )}
        {isReplace && task.fulfillmentType === 'ACCOUNT' && (
          <Form.Item name="reclaimTo" label="原来的号">
            <Radio.Group
              options={[
                { value: 'VOID', label: '作废（封号 / 不能用了）' },
                { value: 'STOCK', label: '回库，之后再卖' },
              ]}
            />
          </Form.Item>
        )}
        {task.chargeMode !== 'none' && (
          <>
            <Divider orientation="left" plain style={{ marginTop: 0 }}>
              上游扣费
            </Divider>
            {!noCharge && (
              <Space.Compact block>
                <Form.Item
                  name="resourceId"
                  label="用哪个付款资源"
                  style={{ flex: 1, marginRight: 12 }}
                  rules={
                    chargeRequired && activeResources.length > 0
                      ? [{ required: true, message: '请选择付款资源，或勾选「本次未扣费」' }]
                      : []
                  }
                  extra={
                    activeResources.length === 0
                      ? '还没有配置付款资源，这次可以先不登记'
                      : chargeRequired
                        ? '会从余额里扣，并按平均成本记到订单'
                        : '从库存发号一般不用付费；号过期了要重新付才选'
                  }
                >
                  <Select
                    allowClear
                    loading={resources.isLoading}
                    options={activeResources.map((r) => ({
                      value: r.id,
                      label: `${r.name}（余额 ${formatCents(r.balanceUsdCents, '$')}）`,
                    }))}
                  />
                </Form.Item>
                <Form.Item
                  name="chargeUsd"
                  label="扣费（美元）"
                  style={{ width: 140 }}
                  extra="不含手续费"
                >
                  <InputNumber min={0.01} style={{ width: '100%' }} />
                </Form.Item>
              </Space.Compact>
            )}
            {chargeRequired && (
              <Form.Item name="noCharge" valuePropName="checked" style={{ marginTop: -8 }}>
                <Checkbox>本次未扣费（例如账号本来就在付费期内）</Checkbox>
              </Form.Item>
            )}
          </>
        )}
        {isActivate && (
          <Form.Item
            name="activatedAt"
            label="实际开通时间"
            extra="服务期从这里开始算；不填 = 现在"
          >
            <DatePicker
              showTime
              style={{ width: '100%' }}
              disabledDate={(d) => d.isAfter(dayjs())}
            />
          </Form.Item>
        )}
        {askUpstream && (
          <Form.Item
            name="upstreamRenewAt"
            label="上游下次扣费时间"
            extra={upstreamHint[task.type]}
          >
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
        )}
        {task.type === 'RECLAIM_ACCOUNT' && (
          <>
            <Form.Item name="reclaimTo" label="收回后">
              <Radio.Group
                options={[
                  { value: 'STOCK', label: '回库，之后再卖' },
                  { value: 'VOID', label: '作废（号已不能用）' },
                ]}
              />
            </Form.Item>
            <Form.Item
              name="accountPassword"
              label="修改后的新密码"
              extra="建议收回后立即改密；不填则不变"
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          </>
        )}
        <Form.Item name="note" label="备注">
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function NoteModal({
  task,
  action,
  onClose,
  onDone,
}: {
  task: Task;
  action: 'fail' | 'cancel';
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ note: string }>();
  const submit = useMutation({
    mutationFn: (note: string) =>
      unwrap(
        action === 'fail'
          ? api.POST('/api/tasks/{id}/fail', { params: { path: { id: task.id } }, body: { note } })
          : api.POST('/api/tasks/{id}/cancel', {
              params: { path: { id: task.id } },
              body: { note },
            }),
      ),
    onSuccess: () => {
      message.success(action === 'fail' ? '已标记失败，处理好后可以重新开始' : '任务已作废');
      onDone();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`${action === 'fail' ? '标记失败' : '作废任务'}：${task.code}`}
      okText="确认"
      okButtonProps={{ danger: true }}
      confirmLoading={submit.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      {action === 'cancel' && (
        <Typography.Paragraph type="secondary">
          {task.type === 'CANCEL_AUTO_RENEW'
            ? '作废后不会取消自动续订，上游到期会继续扣费。只在客户确认马上续费时作废。'
            : '作废后账号继续留在客户手里。只在客户确认马上续费时作废。'}
        </Typography.Paragraph>
      )}
      <Form form={form} layout="vertical" onFinish={(v) => submit.mutate(v.note)}>
        <Form.Item name="note" label="原因" rules={[{ required: true, message: '请填写原因' }]}>
          <Input.TextArea rows={3} maxLength={500} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function AssignModal({
  task,
  onClose,
  onDone,
}: {
  task: Task;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const staff = useStaffOptions();
  const [assigneeId, setAssigneeId] = useState<string | null>(task.assignee?.id ?? null);
  const assign = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/tasks/{id}/assign', {
          params: { path: { id: task.id } },
          body: { assigneeId },
        }),
      ),
    onSuccess: () => {
      message.success(assigneeId ? '已转交' : '已放回任务池');
      onDone();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`转交任务：${task.code}`}
      okText="确认"
      confirmLoading={assign.isPending}
      onOk={() => assign.mutate()}
      onCancel={onClose}
    >
      <Select
        style={{ width: '100%' }}
        value={assigneeId ?? '__pool'}
        onChange={(v: string) => setAssigneeId(v === '__pool' ? null : v)}
        options={[
          { value: '__pool', label: '放回任务池（谁有空谁领）' },
          ...(staff.data ?? [])
            .filter((s) => s.canFulfill)
            .map((s) => ({ value: s.id, label: s.displayName })),
        ]}
      />
    </Modal>
  );
}
