import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Col,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  type TableColumnsType,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CUSTOMER_SOURCES,
  CUSTOMER_STAGE_LABELS,
  LOST_REASONS,
  formatCents,
  lostReasonLabel,
  type CustomerSource,
  type CustomerStage,
  type LostReason,
} from '@crm/shared';
import { api, unwrap, type QueryOf, type Schemas } from '../../api/client';
import { useChannels, useStaffOptions } from '../../api/queries';
import { useAuth } from '../../auth/AuthProvider';
import {
  AGENT_VIEW_PERMISSIONS,
  AgentLink,
  AgentSelect,
  ChannelSelect,
  CustomerSelect,
  CustomerStageTag,
  Money,
} from '../../components/business';
import { formatTime } from '../../components/format';
import { ScriptPicker } from '../../components/scripts';
import { LostReasonModal, RecallModal, customerVars } from './modals';

type Customer = Schemas['CustomerDto'];
type CustomerQuery = QueryOf<'/api/customers'>;
type Sort = NonNullable<CustomerQuery['sort']>;
type View = 'all' | CustomerStage | 'vip';

const SOURCE_LABELS = Object.fromEntries(CUSTOMER_SOURCES.map((s) => [s.value, s.label]));
const SORT_OPTIONS: { value: Sort; label: string }[] = [
  { value: 'createdAt', label: '最新录入' },
  { value: 'netPaid', label: '累计实付最多' },
  { value: 'serviceEnd', label: '服务最近结束' },
  { value: 'lastContact', label: '最久没联系' },
];
const VIEWS: View[] = ['all', 'LEAD', 'NEW', 'ACTIVE', 'DORMANT', 'CHURNED', 'vip'];
/** 召回相关的视图：显示服务结束、上次联系和召回操作 */
const isRecallView = (v: View) => v === 'DORMANT' || v === 'CHURNED';

interface Filters {
  page: number;
  pageSize: number;
  keyword?: string;
  source?: CustomerSource;
  ownerId?: string;
  agentId?: string;
  channelId?: string;
  lostReason?: LostReason;
  uncontacted?: boolean;
  sort?: Sort;
}

/** 切换视图时的默认筛选：沉睡只看结束后没联系过的、按服务最近结束排；VIP 按累计实付排 */
function viewDefaults(v: View): Partial<Filters> {
  return {
    uncontacted: v === 'DORMANT' ? true : undefined,
    sort: isRecallView(v) ? 'serviceEnd' : v === 'vip' ? 'netPaid' : undefined,
  };
}

/** 服务结束后还没联系过 */
const uncontacted = (c: Customer) =>
  !!c.serviceEndAt &&
  (!c.lastContactAt || new Date(c.lastContactAt).getTime() < new Date(c.serviceEndAt).getTime());

export function CustomersPage() {
  const { can, profile } = useAuth();
  const navigate = useNavigate();
  // 工作台「待召回客户」带 ?view=DORMANT 进来
  const [params] = useSearchParams();
  const initialView = VIEWS.find((v) => v === params.get('view')) ?? 'all';
  const [view, setView] = useState<View>(initialView);
  const [filters, setFilters] = useState<Filters>(() => ({
    page: 1,
    pageSize: 20,
    // 渠道台账点客户数带 ?channelId= 进来
    channelId: params.get('channelId') ?? undefined,
    ...viewDefaults(initialView),
  }));
  const [creating, setCreating] = useState(false);
  const [recalling, setRecalling] = useState<Customer | null>(null);
  const [losing, setLosing] = useState<Customer | null>(null);
  const staff = useStaffOptions();
  const hasChannels = (useChannels().data?.length ?? 0) > 0;
  const query: CustomerQuery = {
    ...filters,
    stage: view !== 'all' && view !== 'vip' ? view : undefined,
    vip: view === 'vip' ? true : undefined,
    uncontacted: view === 'DORMANT' ? filters.uncontacted : undefined,
    lostReason: isRecallView(view) ? filters.lostReason : undefined,
  };
  const customers = useQuery({
    queryKey: ['customers', query],
    queryFn: () => unwrap(api.GET('/api/customers', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const segments = useQuery({
    queryKey: ['customers', 'segments'],
    queryFn: () => unwrap(api.GET('/api/customers/segments')),
  });
  const seg = segments.data;
  const stageCount = (stage: CustomerStage) =>
    seg?.stages.find((s) => s.stage === stage)?.count ?? 0;
  const canWrite = can('customer:write');
  const recall = isRecallView(view);

  const switchView = (v: View) => {
    setView(v);
    setFilters((f) => ({
      page: 1,
      pageSize: f.pageSize,
      keyword: f.keyword,
      ownerId: f.ownerId,
      ...viewDefaults(v),
    }));
  };

  const columns: TableColumnsType<Customer> = [
    {
      title: '客户',
      key: 'name',
      render: (_, c) => (
        <Space direction="vertical" size={0}>
          <Link to={`/customers/${c.id}`}>
            <Typography.Text strong style={{ whiteSpace: 'nowrap' }}>
              {c.name}
            </Typography.Text>
          </Link>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {c.code}
          </Typography.Text>
          {c.tags.length > 0 && (
            <Space size={2} wrap>
              {c.tags.map((t) => (
                <Tag key={t} style={{ marginInlineEnd: 0, fontSize: 11 }}>
                  {t}
                </Tag>
              ))}
            </Space>
          )}
        </Space>
      ),
    },
    {
      title: '阶段',
      key: 'stage',
      render: (_, c) => (
        <Space direction="vertical" size={2}>
          <CustomerStageTag stage={c.stage} vip={c.vip} />
          {c.lostReason && (
            <Tooltip title={c.lostNote ?? undefined}>
              <Typography.Text type="danger" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                {lostReasonLabel(c.lostReason)}
              </Typography.Text>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: '联系方式',
      key: 'contact',
      render: (_, c) => (
        <Space direction="vertical" size={0} style={{ fontSize: 12 }}>
          {c.wechat && <span>微信：{c.wechat}</span>}
          {c.telegram && <span>TG：{c.telegram}</span>}
          {c.phone && <span>手机：{c.phone}</span>}
          {c.email && <span>邮箱：{c.email}</span>}
          {!c.wechat && !c.telegram && !c.phone && !c.email && '—'}
        </Space>
      ),
    },
    ...(recall
      ? []
      : [
          {
            title: '来源',
            key: 'source',
            render: (_: unknown, c: Customer) => (
              <Space direction="vertical" size={0}>
                <span style={{ whiteSpace: 'nowrap' }}>{SOURCE_LABELS[c.source] ?? c.source}</span>
                {c.channel && (
                  <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                    渠道：{c.channel.name}
                  </Typography.Text>
                )}
                {c.referrer && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    推荐人：{c.referrer.name}
                  </Typography.Text>
                )}
                {c.agent && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    代理：
                    <AgentLink agent={c.agent} />
                  </Typography.Text>
                )}
              </Space>
            ),
          },
        ]),
    {
      title: '累计实付',
      key: 'netPaid',
      render: (_, c) =>
        c.paidOrderCount > 0 ? (
          <Space direction="vertical" size={0}>
            <Money cents={c.netPaidCents} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {c.paidOrderCount} 单
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: '服务',
      key: 'subs',
      render: (_, c) =>
        c.activeSubscriptionCount > 0 ? (
          <Space direction="vertical" size={0}>
            <span>服务中 {c.activeSubscriptionCount} 个</span>
            <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              最近到期 {formatTime(c.nextExpiryAt).slice(0, 10)}
            </Typography.Text>
          </Space>
        ) : c.serviceEndAt ? (
          <Typography.Text type="secondary" style={{ whiteSpace: 'nowrap' }}>
            {formatTime(c.serviceEndAt).slice(0, 10)} 结束
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">无</Typography.Text>
        ),
    },
    {
      title: '上次联系',
      key: 'lastContact',
      render: (_, c) => (
        <Space direction="vertical" size={0}>
          <span style={{ whiteSpace: 'nowrap' }}>
            {c.lastContactAt ? formatTime(c.lastContactAt).slice(0, 10) : '—'}
          </span>
          {recall && uncontacted(c) && <Tag color="red">结束后没联系过</Tag>}
        </Space>
      ),
    },
    {
      title: '负责人',
      key: 'owner',
      render: (_, c) => <span style={{ whiteSpace: 'nowrap' }}>{c.owner.displayName}</span>,
    },
    ...(view === 'all' || view === 'LEAD'
      ? [
          {
            title: '录入时间',
            key: 'createdAt',
            render: (_: unknown, c: Customer) => (
              <span style={{ whiteSpace: 'nowrap' }}>{formatTime(c.createdAt).slice(0, 10)}</span>
            ),
          },
        ]
      : []),
    ...(recall && canWrite
      ? [
          {
            title: '操作',
            key: 'actions',
            fixed: 'right' as const,
            render: (_: unknown, c: Customer) => (
              <Space size={0} wrap style={{ maxWidth: 150 }}>
                <ScriptPicker category="recall" vars={customerVars(c)} />
                <Button type="link" size="small" onClick={() => setRecalling(c)}>
                  记录召回
                </Button>
                <Button type="link" size="small" danger onClick={() => setLosing(c)}>
                  流失原因
                </Button>
              </Space>
            ),
          },
        ]
      : []),
  ];

  return (
    <Card
      title="客户"
      extra={
        canWrite && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            新增客户
          </Button>
        )
      }
    >
      <Tabs
        activeKey={view}
        onChange={(k) => switchView(k as View)}
        items={VIEWS.map((v) => ({
          key: v,
          label:
            v === 'all'
              ? `全部 ${seg?.total ?? ''}`
              : v === 'vip'
                ? `VIP ${seg?.vip ?? ''}`
                : `${CUSTOMER_STAGE_LABELS[v]} ${seg ? stageCount(v) : ''}`,
        }))}
      />
      {view === 'DORMANT' && seg && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={`服务结束 ${seg.recallWindowDays} 天内的客户，是召回的黄金期（超过就算流失）。先点「话术」复制发给客户，再点「记录召回」写下沟通情况；客户明确不续了就记个流失原因。`}
        />
      )}
      {view === 'vip' && seg && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          message={`累计实付满 ${formatCents(seg.vipThresholdCents)} 的客户（门槛在业务设置里改）。`}
        />
      )}
      <div className="page-toolbar">
        <div className="page-toolbar-filters">
          <Input.Search
            placeholder="编号、称呼、微信、TG、手机号"
            allowClear
            style={{ width: 240 }}
            onSearch={(keyword) =>
              setFilters((f) => ({ ...f, page: 1, keyword: keyword || undefined }))
            }
          />
          {!recall && (
            <Select
              placeholder="来源"
              allowClear
              style={{ width: 120 }}
              value={filters.source}
              options={CUSTOMER_SOURCES.map((s) => ({ value: s.value, label: s.label }))}
              onChange={(source?: CustomerSource) => setFilters((f) => ({ ...f, page: 1, source }))}
            />
          )}
          {!recall && hasChannels && (
            <ChannelSelect
              placeholder="渠道"
              allowDisabled
              withNone
              style={{ width: 160 }}
              value={filters.channelId}
              onChange={(channelId) =>
                setFilters((f) => ({ ...f, page: 1, channelId: channelId ?? undefined }))
              }
            />
          )}
          {recall && (
            <Select
              placeholder="流失原因"
              allowClear
              style={{ width: 170 }}
              value={filters.lostReason}
              options={LOST_REASONS.map((r) => ({
                value: r.value,
                label: `${r.label} ${seg?.lostReasons.find((x) => x.reason === r.value)?.count ?? 0}`,
              }))}
              onChange={(lostReason?: LostReason) =>
                setFilters((f) => ({ ...f, page: 1, lostReason }))
              }
            />
          )}
          {profile?.dataScope !== 'SELF' && (
            <Select
              placeholder="负责人"
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: 140 }}
              value={filters.ownerId}
              options={(staff.data ?? []).map((s) => ({ value: s.id, label: s.displayName }))}
              onChange={(ownerId?: string) => setFilters((f) => ({ ...f, page: 1, ownerId }))}
            />
          )}
          {!recall && AGENT_VIEW_PERMISSIONS.some((p) => can(p)) && (
            <AgentSelect
              placeholder="代理"
              allowDisabled
              style={{ width: 160 }}
              value={filters.agentId}
              onChange={(agentId) =>
                setFilters((f) => ({ ...f, page: 1, agentId: agentId ?? undefined }))
              }
            />
          )}
          <Select<Sort>
            style={{ width: 140 }}
            value={filters.sort ?? 'createdAt'}
            options={SORT_OPTIONS}
            onChange={(sort) => setFilters((f) => ({ ...f, page: 1, sort }))}
          />
          {view === 'DORMANT' && (
            <Checkbox
              checked={!!filters.uncontacted}
              onChange={(e) =>
                setFilters((f) => ({ ...f, page: 1, uncontacted: e.target.checked || undefined }))
              }
            >
              只看结束后没联系过的（{seg?.dormantUncontacted ?? 0}）
            </Checkbox>
          )}
        </div>
        <Button
          icon={<ReloadOutlined />}
          onClick={() => {
            void customers.refetch();
            void segments.refetch();
          }}
        >
          刷新
        </Button>
      </div>
      <Table<Customer>
        rowKey="id"
        columns={columns}
        dataSource={customers.data?.items}
        loading={customers.isFetching}
        scroll={{ x: 1100 }}
        pagination={{
          current: filters.page,
          pageSize: filters.pageSize,
          total: customers.data?.total,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 位客户`,
          onChange: (page, pageSize) => setFilters((f) => ({ ...f, page, pageSize })),
        }}
      />
      {creating && (
        <CustomerFormModal
          customer={null}
          onClose={() => setCreating(false)}
          onSaved={(c) => navigate(`/customers/${c.id}`)}
        />
      )}
      {recalling && <RecallModal customer={recalling} onClose={() => setRecalling(null)} />}
      {losing && <LostReasonModal customer={losing} onClose={() => setLosing(null)} />}
    </Card>
  );
}

interface CustomerForm {
  name: string;
  wechat?: string;
  telegram?: string;
  phone?: string;
  email?: string;
  source: CustomerSource;
  referrerId?: string | null;
  agentId?: string | null;
  channelId?: string | null;
  tags: string[];
  remark?: string;
  ownerId?: string;
}

export function CustomerFormModal({
  customer,
  onClose,
  onSaved,
}: {
  customer: Schemas['CustomerDto'] | null;
  onClose: () => void;
  onSaved: (c: Schemas['CustomerDto']) => void;
}) {
  const { message } = App.useApp();
  const { profile, can } = useAuth();
  const queryClient = useQueryClient();
  const staff = useStaffOptions();
  const [form] = Form.useForm<CustomerForm>();
  const source = Form.useWatch('source', form);
  const isNew = customer === null;
  // 代理字段：来源选「代理」或者已经绑定了代理时显示；已绑定后改绑要「编辑代理」权限
  const showAgent = source === 'agent' || !!customer?.agent;
  const agentLocked = !!customer?.agent && !can('agent:write');
  // 渠道：推荐和代理来的客户不用标；已经标了的照样显示
  const channels = useChannels();
  const showChannel =
    (source !== 'referral' && source !== 'agent' && (channels.data?.length ?? 0) > 0) ||
    !!customer?.channel;
  // 指定其他负责人需要「全部数据」或同组范围
  const ownerOptions = (staff.data ?? [])
    .filter(
      (s) =>
        profile?.dataScope === 'ALL' ||
        s.id === profile?.id ||
        (profile?.dataScope === 'TEAM' && profile.teamId && s.teamId === profile.teamId),
    )
    .map((s) => ({ value: s.id, label: s.displayName }));

  const save = useMutation({
    mutationFn: (v: CustomerForm) => {
      const body = {
        name: v.name,
        wechat: v.wechat || null,
        telegram: v.telegram || null,
        phone: v.phone || null,
        email: v.email || null,
        source: v.source,
        referrerId: v.source === 'referral' ? (v.referrerId ?? null) : null,
        agentId: showAgent && !agentLocked ? (v.agentId ?? null) : undefined,
        channelId: showChannel ? (v.channelId ?? null) : undefined,
        tags: v.tags,
        remark: v.remark || null,
      };
      return isNew
        ? unwrap(api.POST('/api/customers', { body: { ...body, ownerId: v.ownerId } }))
        : unwrap(api.PATCH('/api/customers/{id}', { params: { path: { id: customer.id } }, body }));
    },
    onSuccess: (c) => {
      message.success('已保存');
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      onSaved(c);
      onClose();
    },
  });

  return (
    <Modal
      open
      title={isNew ? '新增客户' : `编辑客户：${customer.name}`}
      okText="保存"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
      width={560}
    >
      <Form<CustomerForm>
        form={form}
        layout="vertical"
        initialValues={
          customer
            ? {
                ...customer,
                wechat: customer.wechat ?? undefined,
                telegram: customer.telegram ?? undefined,
                phone: customer.phone ?? undefined,
                email: customer.email ?? undefined,
                remark: customer.remark ?? undefined,
                source: customer.source as CustomerSource,
                referrerId: customer.referrer?.id ?? null,
                agentId: customer.agent?.id ?? null,
                channelId: customer.channel?.id ?? null,
              }
            : { source: 'organic', tags: [], ownerId: profile?.id }
        }
        onFinish={(v) => save.mutate(v)}
      >
        <Form.Item name="name" label="称呼" rules={[{ required: true, message: '请输入客户称呼' }]}>
          <Input maxLength={32} placeholder="例如：王先生" />
        </Form.Item>
        <Typography.Text
          type="secondary"
          style={{ display: 'block', marginBottom: 8, fontSize: 12 }}
        >
          联系方式至少填一个；同一个微信 / TG / 手机号 / 邮箱只能属于一个客户，避免重复跟进
        </Typography.Text>
        <Row gutter={12}>
          <Col xs={24} sm={12}>
            <Form.Item name="wechat" label="微信">
              <Input maxLength={64} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="telegram" label="Telegram">
              <Input maxLength={64} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="phone" label="手机">
              <Input maxLength={32} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item
              name="email"
              label="邮箱"
              rules={[{ type: 'email', message: '邮箱格式不正确' }]}
            >
              <Input />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="source" label="来源">
          <Select options={CUSTOMER_SOURCES.map((s) => ({ value: s.value, label: s.label }))} />
        </Form.Item>
        {source === 'referral' && (
          <Form.Item name="referrerId" label="推荐人">
            <CustomerSelect
              placeholder="搜索推荐这位客户的老客户"
              initialOption={
                customer?.referrer
                  ? {
                      value: customer.referrer.id,
                      label: `${customer.referrer.name}（${customer.referrer.code}）`,
                    }
                  : undefined
              }
            />
          </Form.Item>
        )}
        {showChannel && (
          <Form.Item
            name="channelId"
            label="渠道"
            extra="具体是哪个账号 / 群 / 投放计划带来的，用来算渠道回报"
          >
            <ChannelSelect />
          </Form.Item>
        )}
        {showAgent && (
          <Form.Item
            name="agentId"
            label="绑定代理"
            extra={
              agentLocked
                ? '已绑定代理，改绑或解绑需要「编辑代理」权限'
                : '客户之后的所有订单都算这个代理的业绩和佣金'
            }
          >
            <AgentSelect disabled={agentLocked} placeholder="选择带来这位客户的代理" />
          </Form.Item>
        )}
        <Form.Item name="tags" label="标签">
          <Select mode="tags" placeholder="输入后回车，例如：老客、大客户" maxCount={10} />
        </Form.Item>
        <Form.Item name="remark" label="备注">
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
        {isNew && ownerOptions.length > 1 && (
          <Form.Item name="ownerId" label="负责人">
            <Select options={ownerOptions} showSearch optionFilterProp="label" />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}
