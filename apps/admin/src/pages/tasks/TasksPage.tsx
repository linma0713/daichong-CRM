import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  App,
  Badge,
  Button,
  Card,
  Input,
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
import { TASK_TYPE_LABELS, TASK_TYPES, type TaskType } from '@crm/shared';
import { api, unwrap, type QueryOf, type Schemas } from '../../api/client';
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
import { AssignModal, CompleteModal, NoteModal } from './modals';

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
