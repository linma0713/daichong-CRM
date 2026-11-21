import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import {
  App,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Result,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
} from 'antd';
import { PhoneOutlined, RightOutlined } from '@ant-design/icons';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FOLLOW_UP_KINDS, MANUAL_FOLLOW_UP_KINDS, type FollowUpKind } from '@crm/shared';
import { api, unwrap, type QueryOf, type Schemas } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { CustomerStageTag, DaysLeft, SubscriptionStatusTag } from '../components/business';
import { formatShortTime, formatTime } from '../components/format';
import { ScriptPicker, useSubscriptionVars } from '../components/scripts';
import { RecallModal } from '../pages/customers/modals';
import { ReminderModal } from '../pages/subscriptions/SubscriptionsPage';
import { MobilePage, Section } from './MobileLayout';

type Customer = Schemas['CustomerDto'];
type Subscription = Schemas['SubscriptionDto'];
type View = 'mine' | 'recall' | 'all';
const PAGE_SIZE = 20;
const KIND = Object.fromEntries(FOLLOW_UP_KINDS.map((k) => [k.value, k]));
type ManualKind = Exclude<FollowUpKind, 'lost_reason'>;

/** 手机版客户列表：默认看我负责的 */
export function MobileCustomersPage() {
  const { profile } = useAuth();
  const [params, setParams] = useSearchParams();
  const view =
    (['mine', 'recall', 'all'] as View[]).find((v) => v === params.get('view')) ?? 'mine';
  const keyword = params.get('keyword') ?? '';
  const query: QueryOf<'/api/customers'> = {
    keyword: keyword || undefined,
    ownerId: view === 'all' ? undefined : profile?.id,
    ...(view === 'recall' ? { stage: 'DORMANT' as const, uncontacted: true } : {}),
  };
  const list = useInfiniteQuery({
    queryKey: ['customers', 'mobile', query],
    queryFn: ({ pageParam }) =>
      unwrap(
        api.GET('/api/customers', {
          params: { query: { ...query, page: pageParam, pageSize: PAGE_SIZE } },
        }),
      ),
    initialPageParam: 1,
    getNextPageParam: (last, all) =>
      all.length * PAGE_SIZE < last.total ? all.length + 1 : undefined,
    enabled: !!profile,
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
    <MobilePage title="客户">
      <div className="m-toolbar">
        <Segmented
          block
          value={view}
          onChange={(v) => update({ view: v as View })}
          options={[
            { value: 'mine', label: '我负责的' },
            { value: 'recall', label: '待召回' },
            { value: 'all', label: '全部' },
          ]}
        />
        <Input.Search
          key={keyword}
          defaultValue={keyword}
          placeholder="称呼、微信、手机号、编号"
          allowClear
          onSearch={(v) => update({ keyword: v.trim() })}
        />
        {view === 'recall' && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            服务结束后变成沉睡、还没联系过的客户。联系后点进去「记录召回」，就会从这里移出。
          </Typography.Text>
        )}
      </div>
      {list.isLoading ? (
        <Spin style={{ display: 'block', margin: 32 }} />
      ) : items.length === 0 ? (
        <Empty style={{ marginTop: 48 }} description="没有客户" />
      ) : (
        <div className="m-list">
          <Typography.Text type="secondary" className="m-list-count">
            共 {total} 位
          </Typography.Text>
          {items.map((c) => (
            <CustomerCard key={c.id} customer={c} />
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

function CustomerCard({ customer: c }: { customer: Customer }) {
  const navigate = useNavigate();
  const contact = c.wechat
    ? `微信 ${c.wechat}`
    : c.phone
      ? `手机 ${c.phone}`
      : c.telegram
        ? `Telegram ${c.telegram}`
        : (c.email ?? '');
  return (
    <button type="button" className="m-card" onClick={() => navigate(`/m/customers/${c.id}`)}>
      <div className="m-card-row">
        <span className="m-card-title">
          {c.name}
          <span className="m-card-sub">{c.code}</span>
        </span>
        <CustomerStageTag stage={c.stage} vip={c.vip} />
      </div>
      <div className="m-card-row m-card-meta">
        <span>{contact}</span>
        <Space size={4}>
          {c.activeSubscriptionCount > 0
            ? `服务中 ${c.activeSubscriptionCount} 个`
            : c.lastContactAt
              ? `上次联系 ${formatShortTime(c.lastContactAt)}`
              : '还没联系过'}
          <RightOutlined style={{ fontSize: 11 }} />
        </Space>
      </div>
    </button>
  );
}

/** 手机版客户详情：联系方式、订阅、跟进记录，可以写跟进、记录续费提醒、发话术 */
export function MobileCustomerDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [writing, setWriting] = useState(false);
  const [recalling, setRecalling] = useState(false);
  const [reminding, setReminding] = useState<Subscription | null>(null);
  const customer = useQuery({
    queryKey: ['customer', id],
    queryFn: () => unwrap(api.GET('/api/customers/{id}', { params: { path: { id } } })),
  });
  const subs = useQuery({
    queryKey: ['subscriptions', { customerId: id, pageSize: 100 }],
    queryFn: () =>
      unwrap(
        api.GET('/api/subscriptions', { params: { query: { customerId: id, pageSize: 100 } } }),
      ),
    enabled: !!customer.data,
  });
  const subItems = subs.data?.items ?? [];
  // 话术变量取最近要到期的服务中订阅；都结束了取最后结束的那个
  const mainSub =
    subItems
      .filter((s) => s.status === 'ACTIVE')
      .sort((a, b) => a.endAt.localeCompare(b.endAt))[0] ??
    [...subItems].sort((a, b) => b.endAt.localeCompare(a.endAt))[0];
  const scriptVars = useSubscriptionVars(mainSub, customer.data?.name ?? '');

  if (customer.isLoading) {
    return (
      <MobilePage title="客户" back="/m/customers">
        <Spin style={{ display: 'block', margin: 48 }} />
      </MobilePage>
    );
  }
  if (!customer.data) {
    return (
      <MobilePage title="客户" back="/m/customers">
        <Result status="404" title="客户不存在或你没有权限查看" />
      </MobilePage>
    );
  }
  const c = customer.data;
  const canWrite = can('customer:write');
  const lapsed = c.stage === 'DORMANT' || c.stage === 'CHURNED';
  const sortedSubs = [...subItems].sort(
    (a, b) =>
      Number(b.status === 'ACTIVE') - Number(a.status === 'ACTIVE') ||
      a.endAt.localeCompare(b.endAt),
  );

  const footer = canWrite ? (
    <div className="m-actions">
      <Button type="primary" onClick={() => setWriting(true)}>
        写跟进
      </Button>
      <ScriptPicker
        category={lapsed ? 'recall' : c.activeSubscriptionCount > 0 ? 'renewal' : 'quote'}
        vars={{ ...scriptVars, 客服: scriptVars.客服 ?? c.owner.displayName }}
        size="middle"
        type="default"
        text="话术"
      />
      {lapsed && <Button onClick={() => setRecalling(true)}>记录召回</Button>}
      {can('order:write') && (
        <Button onClick={() => navigate(`/orders/new?customerId=${c.id}`)}>录订单</Button>
      )}
    </div>
  ) : undefined;

  return (
    <MobilePage title={c.name} back="/m/customers" footer={footer}>
      <Section>
        <Space size={6} wrap>
          <Typography.Text type="secondary">{c.code}</Typography.Text>
          <CustomerStageTag stage={c.stage} vip={c.vip} />
          {c.tags.map((t) => (
            <Tag key={t}>{t}</Tag>
          ))}
        </Space>
        <dl className="m-fields" style={{ marginTop: 8 }}>
          {c.wechat && (
            <>
              <dt>微信</dt>
              <dd>
                <Typography.Text copyable={{ text: c.wechat }}>{c.wechat}</Typography.Text>
              </dd>
            </>
          )}
          {c.phone && (
            <>
              <dt>手机</dt>
              <dd>
                <a href={`tel:${c.phone}`}>
                  <PhoneOutlined /> {c.phone}
                </a>
              </dd>
            </>
          )}
          {c.telegram && (
            <>
              <dt>Telegram</dt>
              <dd>
                <Typography.Text copyable={{ text: c.telegram }}>{c.telegram}</Typography.Text>
              </dd>
            </>
          )}
          {c.email && (
            <>
              <dt>邮箱</dt>
              <dd>
                <Typography.Text copyable={{ text: c.email }}>{c.email}</Typography.Text>
              </dd>
            </>
          )}
          <dt>负责人</dt>
          <dd>{c.owner.displayName}</dd>
          {c.remark && (
            <>
              <dt>备注</dt>
              <dd>{c.remark}</dd>
            </>
          )}
        </dl>
      </Section>

      <Section title={`订阅（${subItems.length}）`}>
        {subs.isLoading ? (
          <Spin />
        ) : sortedSubs.length === 0 ? (
          <Typography.Text type="secondary">还没有订阅</Typography.Text>
        ) : (
          <div className="m-sublist">
            {sortedSubs.map((s) => (
              <div key={s.id} className="m-subitem">
                <div className="m-card-row">
                  <span>
                    {s.planName} <Typography.Text type="secondary">{s.code}</Typography.Text>
                  </span>
                  <SubscriptionStatusTag status={s.status} />
                </div>
                <div className="m-card-row m-card-meta">
                  <span>
                    {formatTime(s.endAt).slice(0, 10)} 到期{' '}
                    <DaysLeft days={s.daysLeft} status={s.status} />
                  </span>
                  {canWrite && s.status === 'ACTIVE' && (
                    <Button
                      size="small"
                      type={s.needsReminder ? 'primary' : 'default'}
                      onClick={() => setReminding(s)}
                    >
                      记录提醒
                    </Button>
                  )}
                </div>
                {s.needsReminder && (
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    快到期了，还没提醒续费
                  </Typography.Text>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="跟进记录">
        {c.followUps.length === 0 ? (
          <Typography.Text type="secondary">还没有跟进记录</Typography.Text>
        ) : (
          <ul className="m-timeline">
            {c.followUps.slice(0, 20).map((f) => (
              <li key={f.id}>
                <div className="m-card-row m-card-meta">
                  <span>
                    <Tag color={KIND[f.kind]?.color} bordered={false}>
                      {KIND[f.kind]?.label ?? f.kind}
                    </Tag>
                    {f.user?.displayName ?? '系统'}
                  </span>
                  <span>{formatShortTime(f.createdAt)}</span>
                </div>
                <div className="m-timeline-content">{f.content}</div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {writing && (
        <FollowUpModal
          customer={c}
          defaultKind={lapsed ? 'recall' : 'note'}
          onClose={() => setWriting(false)}
        />
      )}
      {recalling && (
        <RecallModal
          customer={c}
          scriptVars={{ ...scriptVars, 客服: scriptVars.客服 ?? c.owner.displayName }}
          onClose={() => setRecalling(false)}
        />
      )}
      {reminding && <ReminderModal subscription={reminding} onClose={() => setReminding(null)} />}
    </MobilePage>
  );
}

function FollowUpModal({
  customer,
  defaultKind,
  onClose,
}: {
  customer: Schemas['CustomerDetailDto'];
  defaultKind: ManualKind;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<{ kind: ManualKind; content: string }>();
  const save = useMutation({
    mutationFn: (v: { kind: ManualKind; content: string }) =>
      unwrap(
        api.POST('/api/customers/{id}/follow-ups', {
          params: { path: { id: customer.id } },
          body: { kind: v.kind, content: v.content.trim() },
        }),
      ),
    onSuccess: () => {
      message.success('已记录');
      void queryClient.invalidateQueries({ queryKey: ['customer', customer.id] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`写跟进：${customer.name}`}
      okText="保存"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{ kind: defaultKind }}
        onFinish={(v) => save.mutate(v)}
      >
        <Form.Item name="kind" label="类型">
          <Segmented
            block
            options={MANUAL_FOLLOW_UP_KINDS.map((k) => ({ value: k, label: KIND[k].label }))}
          />
        </Form.Item>
        <Form.Item
          name="content"
          label="沟通情况"
          rules={[{ required: true, whitespace: true, message: '请填写沟通情况' }]}
        >
          <Input.TextArea rows={4} maxLength={1000} placeholder="例如：客户说下周发工资再续" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
