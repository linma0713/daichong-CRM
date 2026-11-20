import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  type TablePaginationConfig,
} from 'antd';
import { EyeOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import {
  ACCOUNT_STOCK_STATUSES,
  ACCOUNT_STOCK_STATUS_LABELS,
  RESOURCE_TX_TYPE_LABELS,
  RESOURCE_TYPES,
  RESOURCE_TYPE_LABELS,
  formatCents,
  type AccountStockStatus,
  type ResourceType,
} from '@crm/shared';
import { api, unwrap, type QueryOf, type Schemas } from '../../api/client';
import { usePlans, useResources } from '../../api/queries';
import { useAuth } from '../../auth/AuthProvider';
import {
  AccountSecretButton,
  CustomerLink,
  Money,
  StockStatusTag,
  Usd,
} from '../../components/business';
import { formatTime } from '../../components/format';
import { parseAccountLines } from './parse';

type Resource = Schemas['ResourceDto'];
type StockAccount = Schemas['StockAccountDto'];

const yuanToCents = (v?: number | null) =>
  v === undefined || v === null ? undefined : Math.round(v * 100);
const feeText = (r: Pick<Resource, 'feeBp' | 'feeFixedUsdCents'>) => {
  const parts = [];
  if (r.feeBp) parts.push(`${r.feeBp / 100}%`);
  if (r.feeFixedUsdCents) parts.push(formatCents(r.feeFixedUsdCents, '$'));
  return parts.length ? parts.join(' + ') : '无';
};

export function InventoryPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'stock' ? 'stock' : 'resources';
  const summary = useQuery({
    queryKey: ['inventory-summary'],
    queryFn: () => unwrap(api.GET('/api/inventory/summary')),
  });
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card>
        <Row gutter={[16, 16]}>
          <Col xs={12} md={6}>
            <Statistic
              title="付款资源余额"
              value={formatCents(summary.data?.totalBalanceUsdCents ?? 0, '$')}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="余额对应成本"
              value={formatCents(summary.data?.totalCostPoolCents ?? 0)}
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="在库成品号"
              value={summary.data?.pools.reduce((n, p) => n + p.inStock, 0) ?? 0}
              suffix="个"
            />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="库存预警"
              value={
                (summary.data?.lowResources.length ?? 0) +
                (summary.data?.pools.filter((p) => p.low).length ?? 0)
              }
              suffix="项"
              valueStyle={
                (summary.data?.lowResources.length ?? 0) +
                (summary.data?.pools.filter((p) => p.low).length ?? 0)
                  ? { color: '#cf1322' }
                  : undefined
              }
            />
          </Col>
        </Row>
        {summary.data &&
          (summary.data.lowResources.length > 0 || summary.data.pools.some((p) => p.low)) && (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 16 }}
              message={[
                ...summary.data.lowResources.map(
                  (r) => `${r.name} 余额 ${formatCents(r.balanceUsdCents, '$')}，低于预警线`,
                ),
                ...summary.data.pools
                  .filter((p) => p.low)
                  .map(
                    (p) =>
                      `${p.planName} 成品号只剩 ${p.inStock} 个（预警线 ${summary.data.accountStockLow} 个）`,
                  ),
              ].join('；')}
            />
          )}
      </Card>
      <Card>
        <Tabs
          activeKey={tab}
          onChange={(k) => setParams(k === 'stock' ? { tab: 'stock' } : {})}
          items={[
            { key: 'resources', label: '付款资源', children: <ResourcesTab /> },
            {
              key: 'stock',
              label: '成品号库存',
              children: <StockTab pools={summary.data?.pools ?? []} />,
            },
          ]}
        />
      </Card>
    </Space>
  );
}

// ─────────────── 付款资源 ───────────────

function ResourcesTab() {
  const { can } = useAuth();
  const canWrite = can('inventory:write');
  const resources = useResources();
  const [editing, setEditing] = useState<Resource | 'new' | null>(null);
  const [toppingUp, setToppingUp] = useState<Resource | null>(null);
  const [adjusting, setAdjusting] = useState<Resource | null>(null);
  const [viewing, setViewing] = useState<Resource | null>(null);

  return (
    <>
      <div className="page-toolbar">
        <Typography.Text type="secondary">
          付款资源按美元记账；入库时记下实际花的人民币，扣费时按平均成本算到订单上。
        </Typography.Text>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void resources.refetch()}>
            刷新
          </Button>
          {canWrite && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
              新增付款资源
            </Button>
          )}
        </Space>
      </div>
      <Table<Resource>
        rowKey="id"
        size="middle"
        loading={resources.isLoading}
        dataSource={resources.data}
        pagination={false}
        scroll={{ x: 960 }}
        locale={{
          emptyText: canWrite ? '还没有付款资源，点右上角「新增付款资源」' : '还没有付款资源',
        }}
        columns={[
          {
            title: '资源',
            key: 'name',
            render: (_, r) => (
              <Space direction="vertical" size={0}>
                <Space size={4}>
                  <Typography.Text strong>{r.name}</Typography.Text>
                  {r.last4 && <Typography.Text type="secondary">尾号 {r.last4}</Typography.Text>}
                </Space>
                <Space size={4}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {r.code}
                  </Typography.Text>
                  <Tag>{RESOURCE_TYPE_LABELS[r.type]}</Tag>
                  {!r.active && <Tag>已停用</Tag>}
                </Space>
              </Space>
            ),
          },
          {
            title: '账面余额',
            key: 'balance',
            render: (_, r) => (
              <Space direction="vertical" size={0}>
                <Usd cents={r.balanceUsdCents} strong type={r.low ? 'danger' : undefined} />
                {r.low && (
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    低于预警线 {formatCents(r.lowBalanceUsdCents, '$')}
                  </Typography.Text>
                )}
              </Space>
            ),
          },
          {
            title: '平均成本',
            key: 'avg',
            render: (_, r) =>
              r.avgRate ? (
                <Tooltip title={`余额对应成本 ${formatCents(r.costPoolCents)}`}>
                  ¥{r.avgRate.toFixed(4)} / 美元
                </Tooltip>
              ) : (
                '—'
              ),
          },
          { title: '每笔手续费', key: 'fee', render: (_, r) => feeText(r) },
          { title: '备注', key: 'remark', render: (_, r) => r.remark ?? '—' },
          {
            title: '操作',
            key: 'actions',
            fixed: 'right',
            width: 230,
            render: (_, r) => (
              <Space size={0} wrap>
                {canWrite && (
                  <Button type="link" size="small" onClick={() => setToppingUp(r)}>
                    入库
                  </Button>
                )}
                {canWrite && (
                  <Button type="link" size="small" onClick={() => setAdjusting(r)}>
                    盘点
                  </Button>
                )}
                <Button type="link" size="small" onClick={() => setViewing(r)}>
                  流水
                </Button>
                {canWrite && (
                  <Button type="link" size="small" onClick={() => setEditing(r)}>
                    编辑
                  </Button>
                )}
                <ResourceSecretButton resource={r} />
              </Space>
            ),
          },
        ]}
      />
      {editing && (
        <ResourceModal
          resource={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {toppingUp && <TopUpModal resource={toppingUp} onClose={() => setToppingUp(null)} />}
      {adjusting && <AdjustModal resource={adjusting} onClose={() => setAdjusting(null)} />}
      {viewing && <TransactionsDrawer resource={viewing} onClose={() => setViewing(null)} />}
    </>
  );
}

function useInventoryRefresh() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['resources'] });
    void queryClient.invalidateQueries({ queryKey: ['inventory-summary'] });
    void queryClient.invalidateQueries({ queryKey: ['resource-transactions'] });
    void queryClient.invalidateQueries({ queryKey: ['stock-accounts'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };
}

function ResourceSecretButton({ resource }: { resource: Resource }) {
  const { can } = useAuth();
  const { modal } = App.useApp();
  const reveal = useMutation({
    mutationFn: () =>
      unwrap(api.GET('/api/resources/{id}/secret', { params: { path: { id: resource.id } } })),
    onSuccess: (s) =>
      modal.info({
        title: `敏感信息：${s.name}`,
        width: 480,
        content: s.secretNote ? (
          <Typography.Paragraph copyable style={{ whiteSpace: 'pre-wrap', marginTop: 12 }}>
            {s.secretNote}
          </Typography.Paragraph>
        ) : (
          '未录入'
        ),
      }),
  });
  if (!can('account:secret:view') || !resource.hasSecretNote) return null;
  return (
    <Tooltip title="查看卡号等敏感信息（会记录操作日志）">
      <Button
        type="link"
        size="small"
        icon={<EyeOutlined />}
        loading={reveal.isPending}
        onClick={() => reveal.mutate()}
      />
    </Tooltip>
  );
}

interface ResourceForm {
  type: ResourceType;
  name: string;
  last4?: string;
  feePercent?: number;
  feeFixedUsd?: number;
  lowBalanceUsd?: number;
  secretNote?: string;
  remark?: string;
  active?: boolean;
  initialUsd?: number;
  initialCny?: number;
}

function ResourceModal({ resource, onClose }: { resource: Resource | null; onClose: () => void }) {
  const { message } = App.useApp();
  const refresh = useInventoryRefresh();
  const [form] = Form.useForm<ResourceForm>();
  const save = useMutation({
    mutationFn: (v: ResourceForm) => {
      const common = {
        name: v.name,
        last4: v.last4 || undefined,
        feeBp: v.feePercent ? Math.round(v.feePercent * 100) : 0,
        feeFixedUsdCents: yuanToCents(v.feeFixedUsd) ?? 0,
        lowBalanceUsdCents: yuanToCents(v.lowBalanceUsd) ?? 0,
        secretNote: v.secretNote || undefined,
        remark: v.remark || undefined,
      };
      return resource
        ? unwrap(
            api.PATCH('/api/resources/{id}', {
              params: { path: { id: resource.id } },
              body: { ...common, active: v.active },
            }),
          )
        : unwrap(
            api.POST('/api/resources', {
              body: {
                ...common,
                type: v.type,
                initialUsdCents: yuanToCents(v.initialUsd),
                initialCnyCents: yuanToCents(v.initialCny),
              },
            }),
          );
    },
    onSuccess: () => {
      message.success('已保存');
      refresh();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={resource ? `编辑：${resource.name}` : '新增付款资源'}
      okText="保存"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
      width={560}
    >
      <Form<ResourceForm>
        form={form}
        layout="vertical"
        initialValues={
          resource
            ? {
                type: resource.type,
                name: resource.name,
                last4: resource.last4 ?? undefined,
                feePercent: resource.feeBp / 100,
                feeFixedUsd: resource.feeFixedUsdCents / 100,
                lowBalanceUsd: resource.lowBalanceUsdCents / 100,
                remark: resource.remark ?? undefined,
                active: resource.active,
              }
            : { type: 'VIRTUAL_CARD', feePercent: 0, feeFixedUsd: 0 }
        }
        onFinish={(v) => save.mutate(v)}
      >
        <Row gutter={12}>
          <Col span={10}>
            <Form.Item name="type" label="类型" rules={[{ required: true }]}>
              <Select
                disabled={!!resource}
                options={RESOURCE_TYPES.map((t) => ({ value: t, label: RESOURCE_TYPE_LABELS[t] }))}
              />
            </Form.Item>
          </Col>
          <Col span={14}>
            <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
              <Input maxLength={50} placeholder="例如：Visa 虚拟卡 A" />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={12}>
          <Col span={8}>
            <Form.Item name="last4" label="尾号">
              <Input maxLength={8} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="feePercent" label="每笔手续费（%）" tooltip="例如外币交易费 1.5%">
              <InputNumber min={0} max={20} step={0.1} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="feeFixedUsd" label="每笔固定费（美元）">
              <InputNumber min={0} max={100} step={0.1} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item
          name="lowBalanceUsd"
          label="余额预警线（美元）"
          extra="余额低于这个值时，在首页和库存页提醒补货"
        >
          <InputNumber min={0} style={{ width: '100%' }} />
        </Form.Item>
        {!resource && (
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="initialUsd" label="首次入库（美元）">
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="initialCny"
                label="实际花费（元）"
                tooltip="买卡、充值实际付出的人民币，含折扣和手续费；用来算每美元的真实成本"
              >
                <InputNumber min={0} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        )}
        <Form.Item
          name="secretNote"
          label="卡号等敏感信息"
          extra={resource?.hasSecretNote ? '已录入；不填则不改' : '加密保存，查看会记录操作日志'}
        >
          <Input.TextArea rows={2} maxLength={1000} />
        </Form.Item>
        <Form.Item name="remark" label="备注">
          <Input maxLength={200} />
        </Form.Item>
        {resource && (
          <Form.Item
            name="active"
            label="启用"
            valuePropName="checked"
            extra="停用后充值员不能再选它扣费"
          >
            <Switch />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}

function TopUpModal({ resource, onClose }: { resource: Resource; onClose: () => void }) {
  const { message } = App.useApp();
  const refresh = useInventoryRefresh();
  const [form] = Form.useForm<{ usd: number; cny: number; note?: string }>();
  const usd = Form.useWatch('usd', form);
  const cny = Form.useWatch('cny', form);
  const save = useMutation({
    mutationFn: (v: { usd: number; cny: number; note?: string }) =>
      unwrap(
        api.POST('/api/resources/{id}/top-up', {
          params: { path: { id: resource.id } },
          body: {
            usdCents: yuanToCents(v.usd)!,
            cnyCents: yuanToCents(v.cny)!,
            note: v.note || undefined,
          },
        }),
      ),
    onSuccess: () => {
      message.success('已入库');
      refresh();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`入库：${resource.name}`}
      okText="确认入库"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item
              name="usd"
              label="入库金额（美元）"
              rules={[{ required: true, message: '请填写金额' }]}
            >
              <InputNumber min={0.01} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              name="cny"
              label="实际花费（元）"
              rules={[{ required: true, message: '请填写花费' }]}
            >
              <InputNumber min={0} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        {usd > 0 && cny >= 0 && (
          <Typography.Paragraph type="secondary">
            这批每美元成本 ¥{(cny / usd).toFixed(4)}，入库后和原有余额加权平均。
          </Typography.Paragraph>
        )}
        <Form.Item name="note" label="备注">
          <Input maxLength={200} placeholder="例如：闲鱼买 $100 礼品卡" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function AdjustModal({ resource, onClose }: { resource: Resource; onClose: () => void }) {
  const { message } = App.useApp();
  const refresh = useInventoryRefresh();
  const [form] = Form.useForm<{ actual: number; note: string }>();
  const save = useMutation({
    mutationFn: (v: { actual: number; note: string }) =>
      unwrap(
        api.POST('/api/resources/{id}/adjust', {
          params: { path: { id: resource.id } },
          body: { actualUsdCents: yuanToCents(v.actual)!, note: v.note },
        }),
      ),
    onSuccess: () => {
      message.success('已调整');
      refresh();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`盘点：${resource.name}`}
      okText="按实际余额调整"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Typography.Paragraph type="secondary">
        账面余额 {formatCents(resource.balanceUsdCents, '$')}
        。填写卡商后台显示的实际余额，差额会记一笔盘点流水。
      </Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <Form.Item
          name="actual"
          label="实际余额（美元）"
          rules={[{ required: true, message: '请填写实际余额' }]}
        >
          <InputNumber min={0} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="note" label="原因" rules={[{ required: true, message: '请填写原因' }]}>
          <Input maxLength={200} placeholder="例如：月底对账" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function TransactionsDrawer({ resource, onClose }: { resource: Resource; onClose: () => void }) {
  const [page, setPage] = useState({ page: 1, pageSize: 20 });
  const txs = useQuery({
    queryKey: ['resource-transactions', resource.id, page],
    queryFn: () =>
      unwrap(
        api.GET('/api/resources/{id}/transactions', {
          params: { path: { id: resource.id }, query: page },
        }),
      ),
    placeholderData: keepPreviousData,
  });
  return (
    <Drawer open width={760} title={`库存流水：${resource.name}`} onClose={onClose}>
      <Table<Schemas['ResourceTxDto']>
        rowKey="id"
        size="small"
        loading={txs.isLoading}
        dataSource={txs.data?.items}
        scroll={{ x: 640 }}
        pagination={{
          current: page.page,
          pageSize: page.pageSize,
          total: txs.data?.total,
          showSizeChanger: false,
          onChange: (p) => setPage({ page: p, pageSize: 20 }),
        }}
        columns={[
          {
            title: '时间',
            key: 'createdAt',
            width: 150,
            render: (_, t) => formatTime(t.createdAt),
          },
          {
            title: '类型',
            key: 'type',
            width: 80,
            render: (_, t) => RESOURCE_TX_TYPE_LABELS[t.type],
          },
          {
            title: '美元',
            key: 'usd',
            render: (_, t) => (
              <Typography.Text type={t.usdCents < 0 ? 'danger' : 'success'}>
                {t.usdCents > 0 ? '+' : ''}
                {formatCents(t.usdCents, '$')}
              </Typography.Text>
            ),
          },
          { title: '人民币', key: 'cny', render: (_, t) => formatCents(t.cnyCents) },
          { title: '结余', key: 'after', render: (_, t) => <Usd cents={t.balanceAfterUsdCents} /> },
          {
            title: '说明',
            key: 'note',
            render: (_, t) => (
              <Space size={4} wrap>
                {t.note}
                {t.order && <Link to={`/orders/${t.order.id}`}>{t.order.code}</Link>}
              </Space>
            ),
          },
          { title: '操作人', key: 'user', width: 90, render: (_, t) => t.user.displayName },
        ]}
      />
    </Drawer>
  );
}

// ─────────────── 成品号库存 ───────────────

type StockFilters = QueryOf<'/api/stock-accounts'> & { page: number; pageSize: number };

function StockTab({ pools }: { pools: Schemas['StockPoolDto'][] }) {
  const { can } = useAuth();
  const canWrite = can('inventory:write');
  const [filters, setFilters] = useState<StockFilters>({
    page: 1,
    pageSize: 20,
    status: 'IN_STOCK',
  });
  const [adding, setAdding] = useState(false);
  const [charging, setCharging] = useState<StockAccount | null>(null);
  const [editing, setEditing] = useState<StockAccount | null>(null);
  const plans = usePlans();
  const stock = useQuery({
    queryKey: ['stock-accounts', filters],
    queryFn: () => unwrap(api.GET('/api/stock-accounts', { params: { query: filters } })),
    placeholderData: keepPreviousData,
  });
  const pagination: TablePaginationConfig = {
    current: filters.page,
    pageSize: filters.pageSize,
    total: stock.data?.total,
    showSizeChanger: true,
    onChange: (page, pageSize) => setFilters((f) => ({ ...f, page, pageSize })),
  };

  return (
    <>
      {pools.length > 0 && (
        <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
          {pools.map((p) => (
            <Col key={p.planId} xs={12} md={6}>
              <Card
                size="small"
                hoverable
                onClick={() =>
                  setFilters((f) => ({ ...f, page: 1, planId: p.planId, status: 'IN_STOCK' }))
                }
                style={p.low ? { borderColor: '#ffa39e' } : undefined}
              >
                <Statistic
                  title={
                    <Space size={4}>
                      {p.planName}
                      {p.low && <Tag color="red">库存不足</Tag>}
                    </Space>
                  }
                  value={p.inStock}
                  suffix={
                    <Typography.Text type="secondary">在库 · {p.inUse} 使用中</Typography.Text>
                  }
                />
              </Card>
            </Col>
          ))}
        </Row>
      )}
      <div className="page-toolbar">
        <div className="page-toolbar-filters">
          <Input.Search
            placeholder="账号邮箱"
            allowClear
            style={{ width: 220 }}
            onSearch={(keyword) =>
              setFilters((f) => ({ ...f, page: 1, keyword: keyword || undefined }))
            }
          />
          <Select
            placeholder="套餐"
            allowClear
            style={{ width: 120 }}
            value={filters.planId}
            options={plans.data?.map((p) => ({ value: p.id, label: p.name }))}
            onChange={(planId?: string) => setFilters((f) => ({ ...f, page: 1, planId }))}
          />
          <Select
            placeholder="状态"
            allowClear
            style={{ width: 110 }}
            value={filters.status}
            options={ACCOUNT_STOCK_STATUSES.map((s) => ({
              value: s,
              label: ACCOUNT_STOCK_STATUS_LABELS[s],
            }))}
            onChange={(status?: AccountStockStatus) =>
              setFilters((f) => ({ ...f, page: 1, status }))
            }
          />
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void stock.refetch()}>
            刷新
          </Button>
          {canWrite && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)}>
              成品号入库
            </Button>
          )}
        </Space>
      </div>
      <Table<StockAccount>
        rowKey="id"
        size="middle"
        loading={stock.isLoading}
        dataSource={stock.data?.items}
        pagination={pagination}
        scroll={{ x: 1000 }}
        columns={[
          {
            title: '账号',
            key: 'email',
            render: (_, a) => (
              <Space size={0}>
                <Typography.Text copyable>{a.email}</Typography.Text>
                <AccountSecretButton
                  account={{
                    id: a.id,
                    email: a.email,
                    hasPassword: a.hasPassword,
                    hasSecretNote: a.hasSecretNote,
                  }}
                />
              </Space>
            ),
          },
          { title: '套餐', key: 'plan', width: 80, render: (_, a) => a.plan?.name ?? '—' },
          {
            title: '状态',
            key: 'status',
            width: 90,
            render: (_, a) => <StockStatusTag status={a.stockStatus} />,
          },
          {
            title: '待结转成本',
            key: 'cost',
            render: (_, a) =>
              a.stockStatus === 'IN_STOCK' ? <Money cents={a.stockCostCents} /> : '—',
          },
          {
            title: '上游付费到',
            key: 'renew',
            render: (_, a) => {
              if (!a.upstreamRenewAt) return '—';
              const expired = dayjs(a.upstreamRenewAt).isBefore(dayjs());
              return (
                <Typography.Text
                  type={expired && a.stockStatus === 'IN_STOCK' ? 'warning' : undefined}
                >
                  {formatTime(a.upstreamRenewAt)}
                  {expired && a.stockStatus === 'IN_STOCK' ? '（已过期，发号时要重新付费）' : ''}
                </Typography.Text>
              );
            },
          },
          {
            title: '客户',
            key: 'customer',
            render: (_, a) =>
              a.customer ? (
                <Space size={4}>
                  <CustomerLink customer={a.customer} />
                  {a.subscription && (
                    <Link to={`/subscriptions/${a.subscription.id}`}>{a.subscription.code}</Link>
                  )}
                </Space>
              ) : (
                '—'
              ),
          },
          { title: '入库时间', key: 'stockedAt', render: (_, a) => formatTime(a.stockedAt) },
          {
            title: '操作',
            key: 'actions',
            fixed: 'right',
            width: 150,
            render: (_, a) =>
              canWrite && a.stockStatus !== 'IN_USE' ? (
                <Space size={0}>
                  {a.stockStatus === 'IN_STOCK' && (
                    <Button type="link" size="small" onClick={() => setCharging(a)}>
                      登记扣费
                    </Button>
                  )}
                  <Button type="link" size="small" onClick={() => setEditing(a)}>
                    编辑
                  </Button>
                </Space>
              ) : null,
          },
        ]}
      />
      {adding && <AddStockModal onClose={() => setAdding(false)} />}
      {charging && <ChargeStockModal account={charging} onClose={() => setCharging(null)} />}
      {editing && <EditStockModal account={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

interface AddStockForm {
  planId: string;
  lines: string;
  costCny?: number;
  resourceId?: string;
  chargeUsd?: number;
  upstreamRenewAt?: Dayjs;
  remark?: string;
}

function AddStockModal({ onClose }: { onClose: () => void }) {
  const { message, modal } = App.useApp();
  const refresh = useInventoryRefresh();
  const plans = usePlans();
  const resources = useResources();
  const [form] = Form.useForm<AddStockForm>();
  const lines = Form.useWatch('lines', form) ?? '';
  const planId = Form.useWatch('planId', form);
  const resourceId = Form.useWatch('resourceId', form);
  const parsed = parseAccountLines(lines);
  const plan = plans.data?.find((p) => p.id === planId);
  const save = useMutation({
    mutationFn: (v: AddStockForm) =>
      unwrap(
        api.POST('/api/stock-accounts', {
          body: {
            planId: v.planId,
            accounts: parseAccountLines(v.lines).rows,
            costCnyCents: yuanToCents(v.costCny),
            resourceId: v.resourceId,
            chargeUsdCents: v.resourceId ? yuanToCents(v.chargeUsd) : undefined,
            upstreamRenewAt: v.upstreamRenewAt?.toISOString(),
            remark: v.remark || undefined,
          },
        }),
      ),
    onSuccess: (r) => {
      refresh();
      onClose();
      if (r.skipped.length) {
        modal.warning({
          title: `入库 ${r.created} 个，跳过 ${r.skipped.length} 个`,
          content: (
            <ul style={{ paddingLeft: 18 }}>
              {r.skipped.map((s) => (
                <li key={s.email}>
                  {s.email}：{s.reason}
                </li>
              ))}
            </ul>
          ),
        });
      } else {
        message.success(`已入库 ${r.created} 个成品号`);
      }
    },
  });
  return (
    <Modal
      open
      title="成品号入库"
      okText={`入库 ${parsed.rows.length} 个`}
      okButtonProps={{ disabled: parsed.rows.length === 0 || parsed.bad.length > 0 }}
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
      width={640}
    >
      <Form<AddStockForm> form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <Form.Item name="planId" label="套餐" rules={[{ required: true, message: '请选择套餐' }]}>
          <Select
            options={plans.data
              ?.filter((p) => p.active)
              .map((p) => ({ value: p.id, label: p.name }))}
          />
        </Form.Item>
        <Form.Item
          name="lines"
          label="账号"
          rules={[{ required: true, message: '请粘贴账号' }]}
          extra={
            parsed.bad.length
              ? `有 ${parsed.bad.length} 行格式不对：${parsed.bad.slice(0, 3).join('；')}`
              : `每行一个：邮箱----密码（后面可以再加 ----恢复邮箱等信息）。已识别 ${parsed.rows.length} 个`
          }
          validateStatus={parsed.bad.length ? 'error' : undefined}
        >
          <Input.TextArea
            rows={6}
            placeholder={'a1@example.com----Passw0rd1\na2@example.com----Passw0rd2'}
          />
        </Form.Item>
        <Form.Item
          name="costCny"
          label="每个号的其他成本（元）"
          tooltip="买号、邮箱等费用，会在发号时结转到订单"
        >
          <InputNumber min={0} style={{ width: '100%' }} />
        </Form.Item>
        <Row gutter={12}>
          <Col span={14}>
            <Form.Item
              name="resourceId"
              label="已经用哪个付款资源付了第一个月"
              extra="不选 = 这批号还没付费，发号时再付"
            >
              <Select
                allowClear
                options={resources.data
                  ?.filter((r) => r.active)
                  .map((r) => ({
                    value: r.id,
                    label: `${r.name}（余额 ${formatCents(r.balanceUsdCents, '$')}）`,
                  }))}
              />
            </Form.Item>
          </Col>
          <Col span={10}>
            <Form.Item
              name="chargeUsd"
              label="每个号扣费（美元）"
              extra={plan ? `默认官方月费 $${plan.upstreamMonthlyUsdCents / 100}` : undefined}
            >
              <InputNumber min={0.01} disabled={!resourceId} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item
          name="upstreamRenewAt"
          label="上游付费到"
          extra="不填：登记了付款 = 一个月后；没登记 = 空"
        >
          <DatePicker showTime style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="remark" label="备注">
          <Input maxLength={200} placeholder="例如：11 月第二批" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function ChargeStockModal({ account, onClose }: { account: StockAccount; onClose: () => void }) {
  const { message } = App.useApp();
  const refresh = useInventoryRefresh();
  const resources = useResources();
  const [form] = Form.useForm<{ resourceId: string; usd?: number; upstreamRenewAt?: Dayjs }>();
  const save = useMutation({
    mutationFn: (v: { resourceId: string; usd?: number; upstreamRenewAt?: Dayjs }) =>
      unwrap(
        api.POST('/api/stock-accounts/{id}/charge', {
          params: { path: { id: account.id } },
          body: {
            resourceId: v.resourceId,
            usdCents: yuanToCents(v.usd),
            upstreamRenewAt: v.upstreamRenewAt?.toISOString(),
          },
        }),
      ),
    onSuccess: () => {
      message.success('已登记，成本会在发号时结转到订单');
      refresh();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`登记扣费：${account.email}`}
      okText="登记"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Typography.Paragraph type="secondary">
        在库的号到了上游扣费日、或者重新订阅时登记。成本先记在号上，发给客户时一起算进订单。
      </Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <Form.Item
          name="resourceId"
          label="付款资源"
          rules={[{ required: true, message: '请选择付款资源' }]}
        >
          <Select
            options={resources.data
              ?.filter((r) => r.active)
              .map((r) => ({
                value: r.id,
                label: `${r.name}（余额 ${formatCents(r.balanceUsdCents, '$')}）`,
              }))}
          />
        </Form.Item>
        <Form.Item
          name="usd"
          label="扣费金额（美元）"
          extra="不填 = 套餐官方月费；手续费按资源规则自动加"
        >
          <InputNumber min={0.01} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name="upstreamRenewAt"
          label="付费后上游下次扣费时间"
          extra="不填 = 原付费日顺延一个月"
        >
          <DatePicker showTime style={{ width: '100%' }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function EditStockModal({ account, onClose }: { account: StockAccount; onClose: () => void }) {
  const { message } = App.useApp();
  const refresh = useInventoryRefresh();
  const plans = usePlans();
  const [form] = Form.useForm<{
    planId?: string;
    stockStatus: 'IN_STOCK' | 'VOID';
    upstreamRenewAt?: Dayjs | null;
    remark?: string;
  }>();
  const save = useMutation({
    mutationFn: (v: {
      planId?: string;
      stockStatus: 'IN_STOCK' | 'VOID';
      upstreamRenewAt?: Dayjs | null;
      remark?: string;
    }) =>
      unwrap(
        api.PATCH('/api/stock-accounts/{id}', {
          params: { path: { id: account.id } },
          body: {
            planId: v.planId,
            stockStatus: v.stockStatus,
            upstreamRenewAt: v.upstreamRenewAt ? v.upstreamRenewAt.toISOString() : null,
            remark: v.remark ?? null,
          },
        }),
      ),
    onSuccess: () => {
      message.success('已保存');
      refresh();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`编辑成品号：${account.email}`}
      okText="保存"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          planId: account.plan?.id,
          stockStatus: account.stockStatus === 'VOID' ? 'VOID' : 'IN_STOCK',
          upstreamRenewAt: account.upstreamRenewAt ? dayjs(account.upstreamRenewAt) : null,
          remark: account.remark ?? undefined,
        }}
        onFinish={(v) => save.mutate(v)}
      >
        <Form.Item name="planId" label="套餐">
          <Select options={plans.data?.map((p) => ({ value: p.id, label: p.name }))} />
        </Form.Item>
        <Form.Item name="stockStatus" label="库存状态" extra="账号被封或失效时作废，不会再被发出去">
          <Radio.Group
            options={[
              { value: 'IN_STOCK', label: '在库' },
              { value: 'VOID', label: '作废' },
            ]}
          />
        </Form.Item>
        <Form.Item name="upstreamRenewAt" label="上游付费到">
          <DatePicker showTime style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="remark" label="备注">
          <Input maxLength={200} />
        </Form.Item>
      </Form>
      <Descriptions size="small" column={1}>
        <Descriptions.Item label="待结转成本">
          {formatCents(account.stockCostCents)}
        </Descriptions.Item>
      </Descriptions>
    </Modal>
  );
}
