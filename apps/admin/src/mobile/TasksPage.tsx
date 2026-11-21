import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  Alert,
  App,
  Button,
  Empty,
  Input,
  Result,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { RightOutlined } from '@ant-design/icons';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, unwrap, type QueryOf, type Schemas } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import {
  AccountSecretButton,
  FulfillmentTag,
  TaskStatusTag,
  TaskTypeTag,
} from '../components/business';
import { formatShortTime, formatTime } from '../components/format';
import { AssignModal, CompleteModal, NoteModal, TASK_GUIDE } from '../pages/tasks/modals';
import { MobilePage, Section } from './MobileLayout';

type Task = Schemas['TaskDto'];
type View = 'mine' | 'pool' | 'overdue' | 'all';
type TaskQuery = QueryOf<'/api/tasks'>;

const VIEWS: { value: View; label: string; query: TaskQuery }[] = [
  { value: 'mine', label: '我的', query: { view: 'open', assignee: 'me' } },
  { value: 'pool', label: '任务池', query: { view: 'open', assignee: 'unassigned' } },
  { value: 'overdue', label: '超时', query: { view: 'open', overdue: true } },
  { value: 'all', label: '全部', query: { view: 'open' } },
];
const PAGE_SIZE = 20;

/** 手机版任务列表 */
export function MobileTasksPage() {
  const [params, setParams] = useSearchParams();
  const view = VIEWS.find((v) => v.value === params.get('view'))?.value ?? 'mine';
  const keyword = params.get('keyword') ?? '';
  const query = { ...VIEWS.find((v) => v.value === view)!.query, keyword: keyword || undefined };
  const list = useInfiniteQuery({
    queryKey: ['tasks', 'mobile', query],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/tasks', {
          params: { query: { ...query, page: pageParam, pageSize: PAGE_SIZE } },
        }),
      ),
    initialPageParam: 1,
    getNextPageParam: (last, all) =>
      all.length * PAGE_SIZE < last.total ? all.length + 1 : undefined,
    refetchInterval: 60_000,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  const update = (next: { view?: View; keyword?: string }) => {
    const p = new URLSearchParams(params);
    if (next.view) p.set('view', next.view);
    if (next.keyword !== undefined) {
      if (next.keyword) p.set('keyword', next.keyword);
      else p.delete('keyword');
    }
    setParams(p, { replace: true });
  };

  return (
    <MobilePage title="开通任务">
      <div className="m-toolbar">
        <Segmented
          block
          value={view}
          onChange={(v) => update({ view: v as View })}
          options={VIEWS.map((v) => ({ value: v.value, label: v.label }))}
        />
        <Input.Search
          key={keyword}
          defaultValue={keyword}
          placeholder="任务编号、客户、账号邮箱"
          allowClear
          onSearch={(v) => update({ keyword: v.trim() })}
        />
      </div>
      {list.isLoading ? (
        <Spin style={{ display: 'block', margin: 32 }} />
      ) : items.length === 0 ? (
        <Empty
          style={{ marginTop: 48 }}
          description={view === 'mine' ? '手上没有要做的任务' : '没有任务'}
        />
      ) : (
        <div className="m-list">
          <Typography.Text type="secondary" className="m-list-count">
            共 {total} 个
          </Typography.Text>
          {items.map((t) => (
            <TaskCard key={t.id} task={t} />
          ))}
          {list.hasNextPage && (
            <Button
              block
              loading={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              加载更多
            </Button>
          )}
        </div>
      )}
    </MobilePage>
  );
}

function TaskCard({ task: t }: { task: Task }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className={`m-card${t.overdue ? ' m-card-danger' : ''}`}
      onClick={() => navigate(`/m/tasks/${t.id}`)}
    >
      <div className="m-card-row">
        <Space size={4} wrap>
          <TaskTypeTag type={t.type} />
          <FulfillmentTag type={t.fulfillmentType} />
          {t.overdue && <Tag color="red">已超时</Tag>}
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {t.code}
        </Typography.Text>
      </div>
      <div className="m-card-title">
        {t.customer.name}
        <span className="m-card-sub">{t.order?.productName ?? t.subscription?.planName ?? ''}</span>
      </div>
      <div className="m-card-row m-card-meta">
        <span>最晚 {formatShortTime(t.dueAt)}</span>
        <Space size={4}>
          {t.assignee ? t.assignee.displayName : '任务池'}
          <TaskStatusTag status={t.status} />
          <RightOutlined style={{ fontSize: 11 }} />
        </Space>
      </div>
    </button>
  );
}

/** 手机版任务详情：看清楚要做什么，直接开始 / 完成 / 标失败 / 转交 */
export function MobileTaskDetailPage() {
  const { id = '' } = useParams();
  const { profile } = useAuth();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [modal, setModal] = useState<'complete' | 'fail' | 'cancel' | 'assign' | null>(null);
  const task = useQuery({
    queryKey: ['tasks', 'detail', id],
    queryFn: () => unwrap(api.GET('/api/tasks/{id}', { params: { path: { id } } })),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const claim = useMutation({
    mutationFn: () => unwrap(api.POST('/api/tasks/{id}/claim', { params: { path: { id } } })),
    onSuccess: () => {
      message.success('已开始处理');
      refresh();
    },
  });

  if (task.isLoading) {
    return (
      <MobilePage title="任务" back="/m/tasks">
        <Spin style={{ display: 'block', margin: 48 }} />
      </MobilePage>
    );
  }
  if (!task.data) {
    return (
      <MobilePage title="任务" back="/m/tasks">
        <Result status="404" title="任务不存在或你没有权限查看" />
      </MobilePage>
    );
  }
  const t = task.data;
  const finished = t.status === 'DONE' || t.status === 'CANCELLED';
  const takenByOther = t.status === 'IN_PROGRESS' && t.assignee && t.assignee.id !== profile?.id;
  const cancellable = t.type === 'CANCEL_AUTO_RENEW' || t.type === 'RECLAIM_ACCOUNT';

  const footer = finished ? undefined : (
    <div className="m-actions">
      {t.status !== 'IN_PROGRESS' && (
        <Button loading={claim.isPending} onClick={() => claim.mutate()}>
          开始处理
        </Button>
      )}
      {!takenByOther && (
        <Button type="primary" onClick={() => setModal('complete')}>
          完成
        </Button>
      )}
      {!takenByOther && (
        <Button danger onClick={() => setModal('fail')}>
          失败
        </Button>
      )}
      <Button onClick={() => setModal('assign')}>转交</Button>
      {cancellable && <Button onClick={() => setModal('cancel')}>作废</Button>}
    </div>
  );

  return (
    <MobilePage title={`任务 ${t.code}`} back="/m/tasks" footer={footer}>
      <Section>
        <Space size={4} wrap style={{ marginBottom: 8 }}>
          <TaskTypeTag type={t.type} />
          <FulfillmentTag type={t.fulfillmentType} />
          <TaskStatusTag status={t.status} />
          {t.overdue && <Tag color="red">已超时</Tag>}
        </Space>
        <Alert type="info" showIcon message={TASK_GUIDE[t.type]} />
        {t.ticket && (
          <Alert
            type="warning"
            showIcon
            style={{ marginTop: 8 }}
            message={`售后 ${t.ticket.code}`}
            description={t.ticket.description}
          />
        )}
      </Section>

      <Section title="客户和服务">
        <dl className="m-fields">
          <dt>客户</dt>
          <dd>
            <Link to={`/m/customers/${t.customer.id}`}>{t.customer.name}</Link>
            {t.customer.wechat && (
              <Typography.Text copyable={{ text: t.customer.wechat }} type="secondary">
                {' '}
                微信 {t.customer.wechat}
              </Typography.Text>
            )}
          </dd>
          {t.order && (
            <>
              <dt>订单</dt>
              <dd>
                <Link to={`/orders/${t.order.id}`}>{t.order.code}</Link> {t.order.productName}
              </dd>
            </>
          )}
          {t.subscription && (
            <>
              <dt>订阅</dt>
              <dd>
                {t.subscription.code} {t.subscription.planName}
                <br />
                <Typography.Text type="secondary">
                  服务到 {formatTime(t.subscription.endAt).slice(0, 10)}
                </Typography.Text>
              </dd>
            </>
          )}
          <dt>账号</dt>
          <dd>
            {t.account ? (
              <Space size={0} wrap>
                <Typography.Text copyable={{ text: t.account.email }}>
                  {t.account.email}
                </Typography.Text>
                <AccountSecretButton account={t.account} />
              </Space>
            ) : (
              <Typography.Text type="secondary">成品号待分配</Typography.Text>
            )}
          </dd>
          {t.subscription?.upstreamRenewAt &&
            (t.type === 'INTERNAL_RENEW' || t.type === 'CANCEL_AUTO_RENEW') && (
              <>
                <dt>上游扣费</dt>
                <dd>
                  <Typography.Text type="warning">
                    {formatTime(t.subscription.upstreamRenewAt)}
                  </Typography.Text>
                </dd>
              </>
            )}
        </dl>
      </Section>

      <Section title="处理">
        <dl className="m-fields">
          <dt>最晚完成</dt>
          <dd>
            {formatTime(t.dueAt)} {t.overdue && <Tag color="red">已超时</Tag>}
          </dd>
          <dt>处理人</dt>
          <dd>{t.assignee?.displayName ?? '任务池（还没人领）'}</dd>
          {t.attempts > 0 && (
            <>
              <dt>失败次数</dt>
              <dd>
                <Typography.Text type="danger">{t.attempts} 次</Typography.Text>
              </dd>
            </>
          )}
          {t.note && (
            <>
              <dt>备注</dt>
              <dd>{t.note}</dd>
            </>
          )}
          {finished && (
            <>
              <dt>结束时间</dt>
              <dd>{formatTime(t.finishedAt)}</dd>
            </>
          )}
        </dl>
        {takenByOther && (
          <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0', fontSize: 13 }}>
            {t.assignee?.displayName} 正在处理。要换人处理可以「转交」。
          </Typography.Paragraph>
        )}
      </Section>

      {modal === 'complete' && (
        <CompleteModal task={t} onClose={() => setModal(null)} onDone={refresh} />
      )}
      {(modal === 'fail' || modal === 'cancel') && (
        <NoteModal task={t} action={modal} onClose={() => setModal(null)} onDone={refresh} />
      )}
      {modal === 'assign' && (
        <AssignModal task={t} onClose={() => setModal(null)} onDone={refresh} />
      )}
    </MobilePage>
  );
}
