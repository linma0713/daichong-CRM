import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Segmented,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  type TableColumnsType,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Dayjs } from 'dayjs';
import {
  CHANNEL_PLATFORMS,
  PAYMENT_METHODS,
  REFERRAL_REWARD_STATUS_LABELS,
  REWARD_DISCOUNT,
  channelPlatformLabel,
  formatCents,
  type ChannelPlatform,
  type ReferralRewardStatus,
} from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { useBusinessSettings, useChannels } from '../../api/queries';
import { useAuth } from '../../auth/AuthProvider';
import { CustomerLink } from '../../components/business';
import { beijingToday, formatTime, rangePresets } from '../../components/format';

type Channel = Schemas['ChannelDto'];
type Cost = Schemas['ChannelCostDto'];
type Row = Schemas['FunnelRowDto'];
type Reward = Schemas['ReferralRewardDto'];
type Range = [Dayjs, Dayjs];
type TabKey = 'roi' | 'channels' | 'rewards';

const KEY = 'YYYY-MM-DD';
const REWARD_METHODS = [
  ...PAYMENT_METHODS.map((m) => ({ value: m.value as string, label: m.label })),
  { value: REWARD_DISCOUNT, label: '抵扣续费' },
];
const methodLabel = (m: string | null) =>
  m ? (REWARD_METHODS.find((x) => x.value === m)?.label ?? m) : '—';
const STATUS_COLORS: Record<ReferralRewardStatus, string> = {
  PENDING: 'orange',
  PAID: 'green',
  CANCELLED: 'default',
};

const money = (cents: number | null, strong?: boolean) =>
  cents === null ? (
    <Typography.Text type="secondary">—</Typography.Text>
  ) : (
    <Typography.Text
      strong={strong}
      style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}
    >
      {formatCents(cents)}
    </Typography.Text>
  );
const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);

/** 渠道与营销：渠道回报、渠道台账（投放成本）、转介绍奖励 */
export function MarketingPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const canWrite = can('marketing:write');
  const tabs: { key: TabKey; label: string; show: boolean }[] = [
    { key: 'roi', label: '渠道回报', show: canWrite || can('report:read') },
    { key: 'channels', label: '渠道台账', show: canWrite || can('report:read') },
    { key: 'rewards', label: '转介绍奖励', show: canWrite || can('finance:read') },
  ];
  const visible = tabs.filter((t) => t.show);
  const tab = visible.find((t) => t.key === params.get('tab'))?.key ?? visible[0]?.key ?? 'roi';

  return (
    <Card title="渠道与营销" styles={{ body: { paddingTop: 8 } }}>
      <Tabs
        activeKey={tab}
        onChange={(k) => setParams({ tab: k }, { replace: true })}
        destroyOnHidden
        items={visible.map((t) => ({
          key: t.key,
          label: t.label,
          children:
            t.key === 'roi' ? (
              <RoiTab />
            ) : t.key === 'channels' ? (
              <ChannelsTab canWrite={canWrite} />
            ) : (
              <RewardsTab canWrite={canWrite} referrerId={params.get('referrerId') ?? undefined} />
            ),
        }))}
      />
    </Card>
  );
}

// ─────────────── 渠道回报 ───────────────

function Tile({ title, value, hint }: { title: string; value: ReactNode; hint?: string }) {
  return (
    <Card size="small" style={{ height: '100%' }}>
      <Statistic title={title} valueRender={() => value} />
      {hint && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {hint}
        </Typography.Text>
      )}
    </Card>
  );
}

function RoiTab() {
  const [range, setRange] = useState<Range>(() => rangePresets()[3].value);
  const query = { from: range[0].format(KEY), to: range[1].format(KEY) };
  const roi = useQuery({
    queryKey: ['marketing', 'roi', query],
    queryFn: () => unwrap(api.GET('/api/marketing/channel-roi', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const d = roi.data;
  const t = d?.total;

  const funnelColumns = (withCost: boolean, title: string): TableColumnsType<Row> => [
    {
      title,
      key: 'label',
      render: (_, r) => (
        <Space size={6} style={{ whiteSpace: 'nowrap' }}>
          <Typography.Text
            strong={r.key !== 'none'}
            type={r.key === 'none' ? 'secondary' : undefined}
          >
            {r.label}
          </Typography.Text>
          {r.platform && <Tag>{channelPlatformLabel(r.platform)}</Tag>}
        </Space>
      ),
    },
    { title: '新建档', dataIndex: 'leads', key: 'leads', align: 'right' },
    {
      title: '成交',
      key: 'converted',
      align: 'right',
      render: (_, r) => (
        <Space direction="vertical" size={0} style={{ alignItems: 'flex-end' }}>
          <span>{r.converted}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {pct(r.conversionRate)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: <Tooltip title="收齐款的订单 ≥ 2 单；比例按成交客户算">复购</Tooltip>,
      key: 'repeat',
      align: 'right',
      render: (_, r) => (
        <Space direction="vertical" size={0} style={{ alignItems: 'flex-end' }}>
          <span>{r.repeat}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {pct(r.repeatRate)}
          </Typography.Text>
        </Space>
      ),
    },
    { title: '服务中', dataIndex: 'active', key: 'active', align: 'right' },
    {
      title: <Tooltip title="这些客户到今天为止的累计实付（已收 − 已退）">累计实付</Tooltip>,
      key: 'revenue',
      align: 'right',
      render: (_, r) => money(r.revenueCents),
    },
    ...(withCost
      ? [
          {
            title: '投放成本',
            key: 'cost',
            align: 'right' as const,
            render: (_: unknown, r: Row) => (r.key === 'none' ? money(null) : money(r.costCents)),
          },
          {
            title: <Tooltip title="投放成本 ÷ 成交客户数">获客成本</Tooltip>,
            key: 'cac',
            align: 'right' as const,
            render: (_: unknown, r: Row) => money(r.cacCents),
          },
          {
            title: <Tooltip title="(累计实付 − 投放成本) ÷ 投放成本">回报率</Tooltip>,
            key: 'roi',
            align: 'right' as const,
            render: (_: unknown, r: Row) =>
              r.roi === null ? (
                <Typography.Text type="secondary">—</Typography.Text>
              ) : (
                <Typography.Text
                  strong
                  type={r.roi < 0 ? 'danger' : 'success'}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {pct(r.roi)}
                </Typography.Text>
              ),
          },
        ]
      : []),
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div className="page-toolbar" style={{ marginBottom: 0 }}>
        <div className="page-toolbar-filters">
          <DatePicker.RangePicker
            value={range}
            allowClear={false}
            presets={rangePresets()}
            disabledDate={(x) => x.isAfter(beijingToday(), 'day')}
            onChange={(v) => v?.[0] && v[1] && setRange([v[0], v[1]])}
          />
          <Typography.Text type="secondary">
            按客户建档日期分组：这段时间新来的客户后来成交了多少、一共付了多少钱；投放成本按花费日期
          </Typography.Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void roi.refetch()}>
          刷新
        </Button>
      </div>
      {d?.partialScope && (
        <Alert
          type="info"
          showIcon
          message="只统计了你能看到的客户；投放成本是全部的，所以回报率会偏低"
        />
      )}
      <Row gutter={[12, 12]}>
        <Col xs={12} md={6}>
          <Tile title="新建档客户" value={t?.leads ?? 0} />
        </Col>
        <Col xs={12} md={6}>
          <Tile
            title="成交"
            value={t?.converted ?? 0}
            hint={t ? `成交率 ${pct(t.conversionRate)}` : undefined}
          />
        </Col>
        <Col xs={12} md={6}>
          <Tile
            title="投放成本"
            value={money(t?.costCents ?? 0)}
            hint={t?.cacCents != null ? `获客成本 ${formatCents(t.cacCents)} / 人` : undefined}
          />
        </Col>
        <Col xs={12} md={6}>
          <Tile
            title="累计实付"
            value={money(t?.revenueCents ?? 0)}
            hint={t?.roi != null ? `整体回报率 ${pct(t.roi)}` : '登记投放成本后显示回报率'}
          />
        </Col>
      </Row>
      <div>
        <Typography.Title level={5}>按渠道</Typography.Title>
        <Table<Row>
          rowKey="key"
          size="small"
          columns={funnelColumns(true, '渠道')}
          dataSource={d?.byChannel}
          loading={roi.isFetching}
          pagination={false}
          scroll={{ x: 900 }}
          locale={{ emptyText: '还没有渠道，在「渠道台账」里新增' }}
        />
      </div>
      <div>
        <Typography.Title level={5}>按客户来源</Typography.Title>
        <Table<Row>
          rowKey="key"
          size="small"
          columns={funnelColumns(false, '来源')}
          dataSource={d?.bySource}
          loading={roi.isFetching}
          pagination={false}
          scroll={{ x: 640 }}
        />
      </div>
    </Space>
  );
}

// ─────────────── 渠道台账 ───────────────

function ChannelsTab({ canWrite }: { canWrite: boolean }) {
  const { message, modal } = App.useApp();
  const queryClient = useQueryClient();
  const channels = useChannels();
  const [editing, setEditing] = useState<Channel | 'new' | null>(null);
  const [addingCost, setAddingCost] = useState(false);
  const [range, setRange] = useState<Range>(() => rangePresets()[3].value);
  const [channelId, setChannelId] = useState<string>();
  const costQuery = { from: range[0].format(KEY), to: range[1].format(KEY), channelId };
  const costs = useQuery({
    queryKey: ['channel-costs', costQuery],
    queryFn: () => unwrap(api.GET('/api/channel-costs', { params: { query: costQuery } })),
    placeholderData: keepPreviousData,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['channels'] });
    void queryClient.invalidateQueries({ queryKey: ['channel-costs'] });
    void queryClient.invalidateQueries({ queryKey: ['marketing'] });
  };
  const toggle = useMutation({
    mutationFn: (c: Channel) =>
      unwrap(
        api.PATCH('/api/channels/{id}', {
          params: { path: { id: c.id } },
          body: { enabled: !c.enabled },
        }),
      ),
    onSuccess: (c) => {
      message.success(c.enabled ? '已启用' : '已停用');
      refresh();
    },
  });
  const removeChannel = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/api/channels/{id}', { params: { path: { id } } })),
    onSuccess: () => {
      message.success('已删除');
      refresh();
    },
  });
  const removeCost = useMutation({
    mutationFn: (id: string) =>
      unwrap(api.DELETE('/api/channel-costs/{id}', { params: { path: { id } } })),
    onSuccess: () => {
      message.success('已删除');
      refresh();
    },
  });

  const channelColumns: TableColumnsType<Channel> = [
    {
      title: '渠道',
      key: 'name',
      render: (_, c) => (
        <Space direction="vertical" size={0}>
          <Typography.Text strong style={{ whiteSpace: 'nowrap' }}>
            {c.name}
          </Typography.Text>
          {c.note && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {c.note}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: '平台',
      key: 'platform',
      render: (_, c) => <Tag>{channelPlatformLabel(c.platform)}</Tag>,
    },
    {
      title: '客户数',
      key: 'customers',
      align: 'right',
      render: (_, c) =>
        c.customerCount > 0 ? (
          <Link to={`/customers?channelId=${c.id}`}>{c.customerCount}</Link>
        ) : (
          0
        ),
    },
    {
      title: '累计投放',
      key: 'cost',
      align: 'right',
      render: (_, c) => money(c.costCents),
    },
    {
      title: '状态',
      key: 'enabled',
      render: (_, c) =>
        canWrite ? (
          <Switch
            size="small"
            checked={c.enabled}
            checkedChildren="启用"
            unCheckedChildren="停用"
            loading={toggle.isPending && toggle.variables?.id === c.id}
            onChange={() => toggle.mutate(c)}
          />
        ) : (
          <Tag color={c.enabled ? 'green' : 'default'}>{c.enabled ? '启用' : '停用'}</Tag>
        ),
    },
    ...(canWrite
      ? [
          {
            title: '操作',
            key: 'actions',
            render: (_: unknown, c: Channel) => (
              <Space size={0}>
                <Button type="link" size="small" onClick={() => setEditing(c)}>
                  编辑
                </Button>
                {c.customerCount === 0 && c.costCents === 0 && (
                  <Button
                    type="link"
                    size="small"
                    danger
                    onClick={() =>
                      modal.confirm({
                        title: `删除渠道「${c.name}」？`,
                        content: '只能删除没有客户和投放成本的渠道；用过的渠道请停用。',
                        okText: '删除',
                        okButtonProps: { danger: true },
                        onOk: () => removeChannel.mutateAsync(c.id),
                      })
                    }
                  >
                    删除
                  </Button>
                )}
              </Space>
            ),
          },
        ]
      : []),
  ];

  const costColumns: TableColumnsType<Cost> = [
    { title: '日期', dataIndex: 'spentOn', key: 'spentOn', width: 110 },
    {
      title: '渠道',
      dataIndex: 'channelName',
      key: 'channel',
      render: (v: string) => <span style={{ whiteSpace: 'nowrap' }}>{v}</span>,
    },
    {
      title: '金额',
      key: 'amount',
      align: 'right',
      render: (_, c) => money(c.amountCents),
    },
    { title: '说明', dataIndex: 'note', key: 'note', render: (v) => v ?? '—' },
    {
      title: '登记人',
      key: 'by',
      render: (_, c) => (
        <Space direction="vertical" size={0}>
          <span style={{ whiteSpace: 'nowrap' }}>{c.createdBy.displayName}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            {formatTime(c.createdAt)}
          </Typography.Text>
        </Space>
      ),
    },
    ...(canWrite
      ? [
          {
            title: '操作',
            key: 'actions',
            render: (_: unknown, c: Cost) => (
              <Button
                type="link"
                size="small"
                danger
                onClick={() =>
                  modal.confirm({
                    title: `删除这笔投放成本（${formatCents(c.amountCents)}）？`,
                    okText: '删除',
                    okButtonProps: { danger: true },
                    onOk: () => removeCost.mutateAsync(c.id),
                  })
                }
              >
                删除
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <Space direction="vertical" size={24} style={{ width: '100%' }}>
      <div>
        <div className="page-toolbar">
          <Typography.Text type="secondary">
            渠道是具体的账号、群或投放计划（例如「小红书-主号」「抖音-直播间」）。录客户时选上渠道，就能算每个渠道带来的成交和回报。
          </Typography.Text>
          {canWrite && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
              新增渠道
            </Button>
          )}
        </div>
        <Table<Channel>
          rowKey="id"
          size="small"
          columns={channelColumns}
          dataSource={channels.data}
          loading={channels.isFetching}
          pagination={false}
          scroll={{ x: 640 }}
        />
      </div>
      <div>
        <Typography.Title level={5}>投放成本</Typography.Title>
        <div className="page-toolbar">
          <div className="page-toolbar-filters">
            <DatePicker.RangePicker
              value={range}
              allowClear={false}
              presets={rangePresets()}
              onChange={(v) => v?.[0] && v[1] && setRange([v[0], v[1]])}
            />
            <Select
              placeholder="全部渠道"
              allowClear
              style={{ width: 180 }}
              value={channelId}
              onChange={setChannelId}
              options={(channels.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
            />
            <Typography.Text>
              合计{' '}
              <Typography.Text strong>{formatCents(costs.data?.totalCents ?? 0)}</Typography.Text>
            </Typography.Text>
          </div>
          {canWrite && (
            <Button
              icon={<PlusOutlined />}
              disabled={!channels.data?.some((c) => c.enabled)}
              onClick={() => setAddingCost(true)}
            >
              登记投放成本
            </Button>
          )}
        </div>
        <Table<Cost>
          rowKey="id"
          size="small"
          columns={costColumns}
          dataSource={costs.data?.items}
          loading={costs.isFetching}
          pagination={{ defaultPageSize: 20, showTotal: (n) => `共 ${n} 笔` }}
          scroll={{ x: 700 }}
        />
      </div>
      {editing && (
        <ChannelModal
          channel={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      {addingCost && (
        <CostModal
          channels={(channels.data ?? []).filter((c) => c.enabled)}
          onClose={() => setAddingCost(false)}
          onSaved={refresh}
        />
      )}
    </Space>
  );
}

function ChannelModal({
  channel,
  onClose,
  onSaved,
}: {
  channel: Channel | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ name: string; platform: ChannelPlatform; note?: string }>();
  const save = useMutation({
    mutationFn: (v: { name: string; platform: ChannelPlatform; note?: string }) =>
      channel
        ? unwrap(
            api.PATCH('/api/channels/{id}', {
              params: { path: { id: channel.id } },
              body: { ...v, note: v.note || null },
            }),
          )
        : unwrap(api.POST('/api/channels', { body: v })),
    onSuccess: () => {
      message.success('已保存');
      onSaved();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={channel ? '编辑渠道' : '新增渠道'}
      okText="保存"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={
          channel
            ? {
                name: channel.name,
                platform: channel.platform as ChannelPlatform,
                note: channel.note ?? undefined,
              }
            : { platform: 'xiaohongshu' }
        }
        onFinish={(v) => save.mutate(v)}
      >
        <Form.Item
          name="name"
          label="渠道名称"
          rules={[{ required: true, whitespace: true, message: '请输入渠道名称' }]}
        >
          <Input maxLength={40} placeholder="例如：小红书-主号" />
        </Form.Item>
        <Form.Item name="platform" label="平台" rules={[{ required: true }]}>
          <Select options={CHANNEL_PLATFORMS.map((p) => ({ value: p.value, label: p.label }))} />
        </Form.Item>
        <Form.Item name="note" label="备注">
          <Input maxLength={200} placeholder="账号 ID、负责人等" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

interface CostForm {
  channelId: string;
  spentOn: Dayjs;
  amountYuan: number;
  note?: string;
}

function CostModal({
  channels,
  onClose,
  onSaved,
}: {
  channels: Channel[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<CostForm>();
  const save = useMutation({
    mutationFn: (v: CostForm) =>
      unwrap(
        api.POST('/api/channel-costs', {
          body: {
            channelId: v.channelId,
            spentOn: v.spentOn.format(KEY),
            amountCents: Math.round(v.amountYuan * 100),
            note: v.note || undefined,
          },
        }),
      ),
    onSuccess: () => {
      message.success('已登记');
      onSaved();
      onClose();
    },
  });
  return (
    <Modal
      open
      title="登记投放成本"
      okText="保存"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Form<CostForm>
        form={form}
        layout="vertical"
        initialValues={{ spentOn: beijingToday(), channelId: channels[0]?.id }}
        onFinish={(v) => save.mutate(v)}
      >
        <Form.Item
          name="channelId"
          label="渠道"
          rules={[{ required: true, message: '请选择渠道' }]}
        >
          <Select options={channels.map((c) => ({ value: c.id, label: c.name }))} />
        </Form.Item>
        <Row gutter={12}>
          <Col xs={24} sm={12}>
            <Form.Item name="spentOn" label="花费日期" rules={[{ required: true }]}>
              <DatePicker
                style={{ width: '100%' }}
                allowClear={false}
                disabledDate={(d) => d.isAfter(beijingToday(), 'day')}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item
              name="amountYuan"
              label="金额（元）"
              rules={[{ required: true, message: '请输入金额' }]}
            >
              <InputNumber
                min={0.01}
                max={10000000}
                precision={2}
                prefix="¥"
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="note" label="说明">
          <Input maxLength={200} placeholder="例如：薯条加热 3 天、达人推广" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ─────────────── 转介绍奖励 ───────────────

function RewardsTab({ canWrite, referrerId }: { canWrite: boolean; referrerId?: string }) {
  const { can } = useAuth();
  const [, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const settings = useBusinessSettings();
  const [status, setStatus] = useState<ReferralRewardStatus | 'all'>(
    referrerId ? 'all' : 'PENDING',
  );
  const [page, setPage] = useState({ page: 1, pageSize: 20 });
  const [paying, setPaying] = useState<Reward | null>(null);
  const [cancelling, setCancelling] = useState<Reward | null>(null);
  const query = {
    ...page,
    status: status === 'all' ? undefined : status,
    referrerId,
  };
  const rewards = useQuery({
    queryKey: ['referral-rewards', query],
    queryFn: () => unwrap(api.GET('/api/referral-rewards', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['referral-rewards'] });
    void queryClient.invalidateQueries({ queryKey: ['customers'] });
  };
  const amount = settings.data?.referralRewardCents;

  const columns: TableColumnsType<Reward> = [
    {
      title: '编号',
      key: 'code',
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <span style={{ whiteSpace: 'nowrap' }}>{r.code}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            {formatTime(r.createdAt)}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '推荐人（拿奖励）',
      key: 'referrer',
      render: (_, r) => <CustomerLink customer={r.referrer} />,
    },
    {
      title: '新客户',
      key: 'referee',
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <CustomerLink customer={r.referee} />
          <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
            首单{' '}
            {can('order:read') ? (
              <Link to={`/orders/${r.orderId}`}>{r.orderCode}</Link>
            ) : (
              r.orderCode
            )}
          </Typography.Text>
        </Space>
      ),
    },
    { title: '金额', key: 'amount', align: 'right', render: (_, r) => money(r.amountCents, true) },
    {
      title: '状态',
      key: 'status',
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Tag color={STATUS_COLORS[r.status]}>{REFERRAL_REWARD_STATUS_LABELS[r.status]}</Tag>
          {r.cancelReason && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {r.cancelReason}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: '发放',
      key: 'paid',
      render: (_, r) =>
        r.status === 'PAID' ? (
          <Space direction="vertical" size={0} style={{ fontSize: 12 }}>
            <span style={{ whiteSpace: 'nowrap' }}>
              {methodLabel(r.method)}
              {r.reference ? ` · ${r.reference}` : ''}
            </span>
            <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              {formatTime(r.paidAt)} · {r.paidBy?.displayName ?? '—'}
            </Typography.Text>
          </Space>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    ...(canWrite
      ? [
          {
            title: '操作',
            key: 'actions',
            render: (_: unknown, r: Reward) =>
              r.status === 'PENDING' ? (
                <Space size={0}>
                  <Button type="link" size="small" onClick={() => setPaying(r)}>
                    发放
                  </Button>
                  <Button type="link" size="small" danger onClick={() => setCancelling(r)}>
                    作废
                  </Button>
                </Space>
              ) : null,
          },
        ]
      : []),
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      {amount === 0 && (
        <Alert
          type="warning"
          showIcon
          message="奖励金额还是 0，推荐的新客户成交后不会生成奖励"
          description={
            can('settings:write') ? (
              <span>
                在 <Link to="/settings">业务设置 → 转介绍奖励</Link>{' '}
                里填每推荐成交一位新客户奖励多少钱。
              </span>
            ) : (
              '请管理员在「业务设置」里填写奖励金额。'
            )
          }
        />
      )}
      {amount !== undefined && amount > 0 && (
        <Typography.Text type="secondary">
          老客户推荐的新客户第一单收齐款后，自动生成一条 {formatCents(amount)}{' '}
          的待发放奖励；新客户首单全额退款会自动作废。
          现金发放计入财务的「营销支出」，抵扣续费的在下单时填优惠，不重复算。
        </Typography.Text>
      )}
      <div className="page-toolbar" style={{ marginBottom: 0 }}>
        <div className="page-toolbar-filters">
          <Segmented
            value={status}
            onChange={(v) => {
              setStatus(v as typeof status);
              setPage((p) => ({ ...p, page: 1 }));
            }}
            options={[
              {
                value: 'PENDING',
                label: `待发放${rewards.data ? ` ${rewards.data.pendingCount}` : ''}`,
              },
              { value: 'PAID', label: '已发放' },
              { value: 'CANCELLED', label: '已作废' },
              { value: 'all', label: '全部' },
            ]}
          />
          {(rewards.data?.pendingCents ?? 0) > 0 && (
            <Typography.Text>
              待发放合计{' '}
              <Typography.Text strong>{formatCents(rewards.data!.pendingCents)}</Typography.Text>
            </Typography.Text>
          )}
          {referrerId && (
            <Tag closable onClose={() => setParams({ tab: 'rewards' }, { replace: true })}>
              只看一位推荐人
            </Tag>
          )}
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void rewards.refetch()}>
          刷新
        </Button>
      </div>
      <Table<Reward>
        rowKey="id"
        size="small"
        columns={columns}
        dataSource={rewards.data?.items}
        loading={rewards.isFetching}
        scroll={{ x: 900 }}
        pagination={{
          current: page.page,
          pageSize: page.pageSize,
          total: rewards.data?.total,
          showTotal: (n) => `共 ${n} 条`,
          onChange: (p, s) => setPage({ page: p, pageSize: s }),
        }}
      />
      {paying && (
        <PayRewardModal reward={paying} onClose={() => setPaying(null)} onSaved={refresh} />
      )}
      {cancelling && (
        <CancelRewardModal
          reward={cancelling}
          onClose={() => setCancelling(null)}
          onSaved={refresh}
        />
      )}
    </Space>
  );
}

function PayRewardModal({
  reward,
  onClose,
  onSaved,
}: {
  reward: Reward;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ method: string; reference?: string }>();
  const method = Form.useWatch('method', form);
  const pay = useMutation({
    mutationFn: (v: { method: string; reference?: string }) =>
      unwrap(
        api.POST('/api/referral-rewards/{id}/pay', {
          params: { path: { id: reward.id } },
          body: {
            method: v.method as Schemas['PayRewardDto']['method'],
            reference: v.reference || undefined,
          },
        }),
      ),
    onSuccess: () => {
      message.success('已登记发放');
      onSaved();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`发放奖励 ${reward.code}`}
      okText="确认已发放"
      confirmLoading={pay.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Typography.Paragraph>
        给推荐人 <Typography.Text strong>{reward.referrer.name}</Typography.Text>（
        {reward.referrer.code}）发放{' '}
        <Typography.Text strong>{formatCents(reward.amountCents)}</Typography.Text>
        ，感谢推荐 {reward.referee.name}。
      </Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ method: 'wechat' }}
        onFinish={(v) => pay.mutate(v)}
      >
        <Form.Item name="method" label="发放方式" rules={[{ required: true }]}>
          <Select options={REWARD_METHODS} />
        </Form.Item>
        {method === REWARD_DISCOUNT && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="抵扣续费：客户下次下单时，在订单上填这笔优惠。这里只登记，不算营销支出（优惠已经体现在订单金额里）。"
          />
        )}
        <Form.Item name="reference" label={method === REWARD_DISCOUNT ? '备注' : '转账单号 / 备注'}>
          <Input maxLength={100} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function CancelRewardModal({
  reward,
  onClose,
  onSaved,
}: {
  reward: Reward;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ reason: string }>();
  const cancel = useMutation({
    mutationFn: (v: { reason: string }) =>
      unwrap(
        api.POST('/api/referral-rewards/{id}/cancel', {
          params: { path: { id: reward.id } },
          body: v,
        }),
      ),
    onSuccess: () => {
      message.success('已作废');
      onSaved();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`作废奖励 ${reward.code}`}
      okText="作废"
      okButtonProps={{ danger: true }}
      confirmLoading={cancel.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Form form={form} layout="vertical" onFinish={(v) => cancel.mutate(v)}>
        <Form.Item
          name="reason"
          label="作废原因"
          rules={[{ required: true, whitespace: true, message: '请填写作废原因' }]}
        >
          <Input maxLength={200} placeholder="例如：推荐人说不用了、重复推荐" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
