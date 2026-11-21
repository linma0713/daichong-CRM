import { useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  Button,
  Card,
  Col,
  Descriptions,
  Result,
  Row,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Typography,
  type TableColumnsType,
} from 'antd';
import { useQuery } from '@tanstack/react-query';
import { PAYMENT_METHODS, formatCents, formatRate } from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { useBusinessSettings } from '../../api/queries';
import { useAuth } from '../../auth/AuthProvider';
import {
  AgentLink,
  AgentStatusTag,
  CustomerLink,
  Money,
  OrderStatusTag,
} from '../../components/business';
import { formatTime } from '../../components/format';
import { AgentFormModal, AgentRates, RateText } from './AgentsPage';

type AgentOrder = Schemas['AgentOrderDto'];
type AgentCustomer = Schemas['AgentCustomerDto'];

const METHOD_LABELS = Object.fromEntries(PAYMENT_METHODS.map((m) => [m.value, m.label]));

export function AgentDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const settings = useBusinessSettings();
  const defaults = settings.data?.commissionRatesBp;
  const agent = useQuery({
    queryKey: ['agent', id],
    queryFn: () => unwrap(api.GET('/api/agents/{id}', { params: { path: { id } } })),
  });

  if (agent.isLoading) return <Spin style={{ display: 'block', margin: 48 }} />;
  if (!agent.data) return <Result status="404" title="代理不存在" />;
  const a = agent.data;

  const orderColumns: TableColumnsType<AgentOrder> = [
    {
      title: '订单',
      key: 'code',
      render: (_, o) => (
        <Space direction="vertical" size={0}>
          <Link to={`/orders/${o.id}`}>{o.code}</Link>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatTime(o.createdAt)}
          </Typography.Text>
        </Space>
      ),
    },
    { title: '客户', key: 'customer', render: (_, o) => <CustomerLink customer={o.customer} /> },
    {
      title: '商品',
      key: 'product',
      render: (_, o) => (
        <Space size={4}>
          {o.firstOrder && <Tag color="blue">首单</Tag>}
          <span>{o.productName}</span>
        </Space>
      ),
    },
    {
      title: '归属',
      key: 'role',
      render: (_, o) =>
        o.role === 'DIRECT' ? (
          '自己的客户'
        ) : (
          <span>
            下级 <AgentLink agent={o.agent} /> 的客户
          </span>
        ),
    },
    {
      title: '实收',
      key: 'paid',
      render: (_, o) => (
        <Space direction="vertical" size={0}>
          <Money cents={o.paidCents} />
          {o.refundedCents > 0 && (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              已退 {formatCents(o.refundedCents)}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: '佣金比例 × 基数',
      key: 'rate',
      render: (_, o) => (
        <Space direction="vertical" size={0}>
          <span>{formatRate(o.rateBp)}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            基数 {formatCents(o.baseCents)}
          </Typography.Text>
        </Space>
      ),
    },
    { title: '状态', key: 'status', render: (_, o) => <OrderStatusTag status={o.status} /> },
  ];

  const customerColumns: TableColumnsType<AgentCustomer> = [
    { title: '客户', key: 'customer', render: (_, c) => <CustomerLink customer={c} /> },
    { title: '微信', key: 'wechat', render: (_, c) => c.wechat ?? '—' },
    { title: '绑定时间', key: 'boundAt', render: (_, c) => formatTime(c.boundAt) },
  ];

  const childColumns: TableColumnsType<Schemas['AgentDto']> = [
    { title: '下级代理', key: 'name', render: (_, c) => <AgentLink agent={c} /> },
    { title: '客户', key: 'customers', render: (_, c) => `${c.customerCount} 位` },
    { title: '成交订单', key: 'orders', render: (_, c) => `${c.orderCount} 单` },
    { title: '业绩', key: 'sales', render: (_, c) => <Money cents={c.salesCents} /> },
    {
      title: '管理佣金',
      key: 'rate',
      render: () => <RateText bp={a.parentRateBp} fallbackBp={defaults?.parent} />,
    },
    { title: '状态', key: 'status', render: (_, c) => <AgentStatusTag status={c.status} /> },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            {a.name}
            <Typography.Text type="secondary">{a.code}</Typography.Text>
            <AgentStatusTag status={a.status} />
            <Tag>{a.parent ? '二级代理' : '一级代理'}</Tag>
          </Space>
        }
        extra={can('agent:write') && <Button onClick={() => setEditing(true)}>编辑</Button>}
      >
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={12} md={6}>
            <Statistic title="绑定客户" value={a.customerCount} suffix="位" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="成交订单" value={a.orderCount} suffix="单" />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="业绩（实收 − 退款）" value={formatCents(a.salesCents)} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic title="下级代理" value={a.childCount} suffix="个" />
          </Col>
        </Row>
        <Descriptions column={{ xs: 1, md: 3 }} size="small">
          <Descriptions.Item label="上级">
            {a.parent ? <AgentLink agent={a.parent} /> : '无'}
          </Descriptions.Item>
          <Descriptions.Item label="微信">{a.wechat ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="手机">{a.phone ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="佣金比例">
            <AgentRates agent={a} defaults={defaults} />
          </Descriptions.Item>
          <Descriptions.Item label="佣金收款">
            {a.payoutMethod ? (METHOD_LABELS[a.payoutMethod] ?? a.payoutMethod) : '—'}
            {a.payoutAccount && (
              <Typography.Text copyable style={{ marginLeft: 8 }}>
                {a.payoutAccount}
              </Typography.Text>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="新增时间">{formatTime(a.createdAt)}</Descriptions.Item>
          {a.remark && (
            <Descriptions.Item label="备注" span="filled">
              {a.remark}
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      {!a.parent && (
        <Card title={`下级代理（${a.childCount}）`} size="small">
          <Table
            rowKey="id"
            size="small"
            columns={childColumns}
            dataSource={a.children}
            pagination={false}
            scroll={{ x: 640 }}
            locale={{ emptyText: '还没有下级代理' }}
          />
        </Card>
      )}

      <Card title="订单（最近 100 笔，含下级代理的客户）" size="small">
        <Table<AgentOrder>
          rowKey="id"
          size="small"
          columns={orderColumns}
          dataSource={a.orders}
          pagination={false}
          scroll={{ x: 860 }}
          locale={{ emptyText: '还没有订单' }}
        />
      </Card>

      <Card title={`绑定客户（${a.customerCount}）`} size="small">
        <Table<AgentCustomer>
          rowKey="id"
          size="small"
          columns={customerColumns}
          dataSource={a.customers}
          pagination={a.customers.length > 20 ? { pageSize: 20 } : false}
          scroll={{ x: 480 }}
          locale={{ emptyText: '还没有绑定客户' }}
        />
      </Card>

      {editing && (
        <AgentFormModal
          agent={a}
          onClose={() => setEditing(false)}
          onSaved={() => void agent.refetch()}
        />
      )}
    </Space>
  );
}
