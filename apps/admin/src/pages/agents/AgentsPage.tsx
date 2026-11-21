import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Table,
  Typography,
  type TableColumnsType,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AGENT_STATUS_LABELS,
  AGENT_STATUSES,
  PAYMENT_METHODS,
  formatRate,
  type AgentStatus,
  type PaymentMethod,
} from '@crm/shared';
import { api, unwrap, type QueryOf, type Schemas } from '../../api/client';
import { useBusinessSettings } from '../../api/queries';
import { useAuth } from '../../auth/AuthProvider';
import { AgentLink, AgentSelect, AgentStatusTag, Money } from '../../components/business';
import { bpToPercent, percentToBp } from '../../components/format';

type Agent = Schemas['AgentDto'];
type Filters = QueryOf<'/api/agents'> & { page: number; pageSize: number };
type Defaults = Schemas['CommissionRatesDto'];

/** 佣金比例：单独设置的显示比例，没设置的显示「默认 x%」 */
export function RateText({ bp, fallbackBp }: { bp: number | null; fallbackBp?: number }) {
  if (bp !== null) return <Typography.Text strong>{formatRate(bp)}</Typography.Text>;
  return (
    <Typography.Text type="secondary">
      默认{fallbackBp !== undefined ? ` ${formatRate(fallbackBp)}` : ''}
    </Typography.Text>
  );
}

export function AgentRates({ agent, defaults }: { agent: Agent; defaults?: Defaults }) {
  return (
    <Space direction="vertical" size={0} style={{ fontSize: 12 }}>
      <span>
        首单 <RateText bp={agent.firstRateBp} fallbackBp={defaults?.first} />
      </span>
      <span>
        续费 <RateText bp={agent.renewalRateBp} fallbackBp={defaults?.renewal} />
      </span>
      {!agent.parent && (
        <span>
          管理 <RateText bp={agent.parentRateBp} fallbackBp={defaults?.parent} />
        </span>
      )}
    </Space>
  );
}

export function AgentsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<Filters>({ page: 1, pageSize: 20 });
  const [creating, setCreating] = useState(false);
  const settings = useBusinessSettings();
  const defaults = settings.data?.commissionRatesBp;
  const agents = useQuery({
    queryKey: ['agents', filters],
    queryFn: () => unwrap(api.GET('/api/agents', { params: { query: filters } })),
    placeholderData: keepPreviousData,
  });

  const columns: TableColumnsType<Agent> = [
    {
      title: '代理',
      key: 'name',
      render: (_, a) => (
        <Space direction="vertical" size={0}>
          <Link to={`/agents/${a.id}`}>
            <Typography.Text strong>{a.name}</Typography.Text>
          </Link>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {a.code}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '级别 / 上级',
      key: 'parent',
      render: (_, a) =>
        a.parent ? (
          <Space direction="vertical" size={0}>
            <span>二级代理</span>
            <span style={{ fontSize: 12 }}>
              上级 <AgentLink agent={a.parent} />
            </span>
          </Space>
        ) : (
          <Space direction="vertical" size={0}>
            <span>一级代理</span>
            {a.childCount > 0 && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                下级 {a.childCount} 个
              </Typography.Text>
            )}
          </Space>
        ),
    },
    {
      title: '联系方式',
      key: 'contact',
      render: (_, a) => (
        <Space direction="vertical" size={0} style={{ fontSize: 12 }}>
          {a.wechat && <span>微信：{a.wechat}</span>}
          {a.phone && <span>手机：{a.phone}</span>}
          {!a.wechat && !a.phone && '—'}
        </Space>
      ),
    },
    {
      title: '佣金比例',
      key: 'rates',
      render: (_, a) => <AgentRates agent={a} defaults={defaults} />,
    },
    { title: '客户', key: 'customers', render: (_, a) => `${a.customerCount} 位` },
    { title: '成交订单', key: 'orders', render: (_, a) => `${a.orderCount} 单` },
    {
      title: '业绩',
      key: 'sales',
      render: (_, a) => <Money cents={a.salesCents} strong />,
    },
    { title: '状态', key: 'status', render: (_, a) => <AgentStatusTag status={a.status} /> },
  ];

  return (
    <Card
      title="代理"
      extra={
        can('agent:write') && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            新增代理
          </Button>
        )
      }
    >
      <Typography.Paragraph type="secondary">
        代理最多两级：直推代理拿主佣金，他的上级拿管理佣金。客户第一次下单时绑定代理，之后的续费、再买都算这个代理的。
        比例留空就按商品单独设置的，商品也没设置就按业务设置的默认比例
        {defaults &&
          `（首单 ${formatRate(defaults.first)}、续费 ${formatRate(defaults.renewal)}、上级 ${formatRate(defaults.parent)}）`}
        。业绩 = 已收款订单的实收 − 已退款。
      </Typography.Paragraph>
      <div className="page-toolbar">
        <div className="page-toolbar-filters">
          <Input.Search
            placeholder="编号、名称、微信、手机号"
            allowClear
            style={{ width: 240 }}
            onSearch={(keyword) =>
              setFilters((f) => ({ ...f, page: 1, keyword: keyword || undefined }))
            }
          />
          <Select
            placeholder="状态"
            allowClear
            style={{ width: 110 }}
            options={AGENT_STATUSES.map((s) => ({ value: s, label: AGENT_STATUS_LABELS[s] }))}
            onChange={(status?: AgentStatus) => setFilters((f) => ({ ...f, page: 1, status }))}
          />
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void agents.refetch()}>
          刷新
        </Button>
      </div>
      <Table<Agent>
        rowKey="id"
        columns={columns}
        dataSource={agents.data?.items}
        loading={agents.isFetching}
        scroll={{ x: 960 }}
        locale={{
          emptyText: can('agent:write') ? '还没有代理，点右上角「新增代理」' : '还没有代理',
        }}
        pagination={{
          current: filters.page,
          pageSize: filters.pageSize,
          total: agents.data?.total,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 个代理`,
          onChange: (page, pageSize) => setFilters((f) => ({ ...f, page, pageSize })),
        }}
      />
      {creating && (
        <AgentFormModal
          agent={null}
          onClose={() => setCreating(false)}
          onSaved={(a) => navigate(`/agents/${a.id}`)}
        />
      )}
    </Card>
  );
}

interface AgentForm {
  name: string;
  wechat?: string;
  phone?: string;
  parentId?: string | null;
  firstPercent?: number | null;
  renewalPercent?: number | null;
  parentPercent?: number | null;
  payoutMethod?: PaymentMethod | null;
  payoutAccount?: string;
  remark?: string;
  status?: AgentStatus;
}

const percentInput = (placeholder?: number) => (
  <InputNumber
    min={0}
    max={50}
    step={0.5}
    precision={2}
    suffix="%"
    placeholder={placeholder !== undefined ? `默认 ${placeholder}` : '默认'}
    style={{ width: '100%' }}
  />
);

export function AgentFormModal({
  agent,
  onClose,
  onSaved,
}: {
  agent: Schemas['AgentDetailDto'] | null;
  onClose: () => void;
  onSaved: (a: Schemas['AgentDetailDto']) => void;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const settings = useBusinessSettings();
  const defaults = settings.data?.commissionRatesBp;
  const [form] = Form.useForm<AgentForm>();
  const parentId = Form.useWatch('parentId', form);
  const isNew = agent === null;
  const hasChildren = (agent?.childCount ?? 0) > 0;

  const save = useMutation({
    mutationFn: (v: AgentForm) => {
      const body = {
        name: v.name,
        wechat: v.wechat || null,
        phone: v.phone || null,
        parentId: v.parentId ?? null,
        firstRateBp: percentToBp(v.firstPercent),
        renewalRateBp: percentToBp(v.renewalPercent),
        parentRateBp: v.parentId ? null : percentToBp(v.parentPercent),
        payoutMethod: v.payoutMethod ?? null,
        payoutAccount: v.payoutAccount || null,
        remark: v.remark || null,
      };
      return isNew
        ? unwrap(api.POST('/api/agents', { body }))
        : unwrap(
            api.PATCH('/api/agents/{id}', {
              params: { path: { id: agent.id } },
              body: { ...body, status: v.status },
            }),
          );
    },
    onSuccess: (a) => {
      message.success('已保存');
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      void queryClient.invalidateQueries({ queryKey: ['agent'] });
      void queryClient.invalidateQueries({ queryKey: ['agent-options'] });
      onSaved(a);
      onClose();
    },
  });

  return (
    <Modal
      open
      title={isNew ? '新增代理' : `编辑代理：${agent.name}`}
      okText="保存"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
      width={600}
    >
      <Form<AgentForm>
        form={form}
        layout="vertical"
        initialValues={
          agent
            ? {
                name: agent.name,
                wechat: agent.wechat ?? undefined,
                phone: agent.phone ?? undefined,
                parentId: agent.parent?.id ?? null,
                firstPercent: bpToPercent(agent.firstRateBp),
                renewalPercent: bpToPercent(agent.renewalRateBp),
                parentPercent: bpToPercent(agent.parentRateBp),
                payoutMethod: (agent.payoutMethod as PaymentMethod | null) ?? null,
                payoutAccount: agent.payoutAccount ?? undefined,
                remark: agent.remark ?? undefined,
                status: agent.status,
              }
            : { parentId: null }
        }
        onFinish={(v) => save.mutate(v)}
      >
        <Row gutter={12}>
          <Col xs={24} sm={12}>
            <Form.Item
              name="name"
              label="名称"
              rules={[{ required: true, message: '请输入代理名称' }]}
            >
              <Input maxLength={32} placeholder="例如：小红书-阿杰" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item
              name="parentId"
              label="上级代理"
              extra={
                hasChildren
                  ? '已经有下级的代理只能是一级代理'
                  : '留空 = 一级代理；只能选一级代理作为上级'
              }
            >
              <AgentSelect
                topLevelOnly
                excludeId={agent?.id}
                placeholder="无（一级代理）"
                disabled={hasChildren}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="wechat" label="微信">
              <Input maxLength={64} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="phone" label="手机">
              <Input maxLength={32} />
            </Form.Item>
          </Col>
        </Row>
        <Typography.Text strong>佣金比例</Typography.Text>
        <Typography.Text
          type="secondary"
          style={{ display: 'block', marginBottom: 8, fontSize: 12 }}
        >
          留空 = 按商品单独设置的比例，商品也没设置就按业务设置的默认。改比例只影响之后的新订单。
        </Typography.Text>
        <Row gutter={12}>
          <Col xs={24} sm={8}>
            <Form.Item name="firstPercent" label="客户首单">
              {percentInput(bpToPercent(defaults?.first) ?? undefined)}
            </Form.Item>
          </Col>
          <Col xs={24} sm={8}>
            <Form.Item name="renewalPercent" label="续费 / 再买">
              {percentInput(bpToPercent(defaults?.renewal) ?? undefined)}
            </Form.Item>
          </Col>
          <Col xs={24} sm={8}>
            {parentId ? (
              <Form.Item label="下级成交时的管理佣金">
                <Input disabled placeholder="二级代理没有下级" />
              </Form.Item>
            ) : (
              <Form.Item
                name="parentPercent"
                label="下级成交时的管理佣金"
                tooltip="作为上级时，从下级代理的每笔订单里额外拿的比例"
              >
                {percentInput(bpToPercent(defaults?.parent) ?? undefined)}
              </Form.Item>
            )}
          </Col>
          <Col xs={24} sm={8}>
            <Form.Item name="payoutMethod" label="佣金收款方式">
              <Select
                allowClear
                placeholder="选择"
                options={PAYMENT_METHODS.map((m) => ({ value: m.value, label: m.label }))}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={16}>
            <Form.Item name="payoutAccount" label="收款账号">
              <Input maxLength={100} placeholder="支付宝账号、USDT 地址或银行卡号" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="remark" label="备注">
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
        {!isNew && (
          <Form.Item
            name="status"
            label="状态"
            extra="停用后不能再绑定新客户，已绑定客户的新订单也不再产生佣金；已产生的佣金照常结算"
          >
            <Select
              options={AGENT_STATUSES.map((s) => ({ value: s, label: AGENT_STATUS_LABELS[s] }))}
              style={{ width: 160 }}
            />
          </Form.Item>
        )}
        {!isNew && agent.status === 'ACTIVE' && hasChildren && (
          <Alert
            type="info"
            showIcon
            message={`${agent.name} 有 ${agent.childCount} 个下级代理；停用后，这些下级的新订单不再给 ${agent.name} 管理佣金`}
          />
        )}
      </Form>
    </Modal>
  );
}
