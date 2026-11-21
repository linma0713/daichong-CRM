import { useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Result,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import {
  COST_KIND_LABELS,
  PAYMENT_METHODS,
  formatCents,
  formatRate,
  termLabel,
  type PaymentMethod,
} from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import {
  AgentLink,
  CustomerLink,
  FulfillmentTag,
  Money,
  OrderKindTag,
  OrderStatusTag,
  TaskStatusTag,
  TaskTypeTag,
} from '../../components/business';
import { formatTime } from '../../components/format';
import { RefundRequestModal } from '../aftersales/modals';
import { RefundTable } from '../aftersales/TicketDetailPage';

const METHOD_LABELS = Object.fromEntries(PAYMENT_METHODS.map((m) => [m.value, m.label]));

export function OrderDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const { modal, message } = App.useApp();
  const queryClient = useQueryClient();
  const [paying, setPaying] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const order = useQuery({
    queryKey: ['order', id],
    queryFn: () => unwrap(api.GET('/api/orders/{id}', { params: { path: { id } } })),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['order', id] });
    void queryClient.invalidateQueries({ queryKey: ['orders'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const cancel = useMutation({
    mutationFn: (reason: string) =>
      unwrap(api.POST('/api/orders/{id}/cancel', { params: { path: { id } }, body: { reason } })),
    onSuccess: () => {
      message.success('订单已取消');
      refresh();
    },
  });

  if (order.isLoading) return <Spin style={{ display: 'block', margin: 48 }} />;
  if (!order.data) return <Result status="404" title="订单不存在或你没有权限查看" />;
  const o = order.data;
  const remaining = o.amountCents - o.paidCents;

  const askCancel = () => {
    let reason = '';
    modal.confirm({
      title: `取消订单 ${o.code}？`,
      content: (
        <Input.TextArea
          rows={2}
          placeholder="取消原因（必填）"
          onChange={(e) => {
            reason = e.target.value;
          }}
        />
      ),
      okText: '取消订单',
      okButtonProps: { danger: true },
      cancelText: '不取消',
      onOk: () => {
        if (!reason.trim()) {
          message.warning('请填写取消原因');
          return Promise.reject(new Error('缺少原因'));
        }
        return cancel.mutateAsync(reason);
      },
    });
  };

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            订单 {o.code}
            <OrderStatusTag status={o.status} />
          </Space>
        }
        extra={
          <Space>
            {o.status === 'PENDING_PAYMENT' && can('payment:confirm') && (
              <Button type="primary" onClick={() => setPaying(true)}>
                确认收款
              </Button>
            )}
            {can('ticket:handle') &&
              (o.status === 'FULFILLING' || o.status === 'COMPLETED') &&
              o.refundableCents > 0 && <Button onClick={() => setRefunding(true)}>申请退款</Button>}
            {o.status === 'PENDING_PAYMENT' && o.paidCents === 0 && can('order:write') && (
              <Button danger onClick={askCancel}>
                取消订单
              </Button>
            )}
          </Space>
        }
      >
        {o.status === 'FULFILLING' && (
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="已收齐款，等待充值员完成开通 / 续费任务。"
          />
        )}
        <Descriptions column={{ xs: 1, md: 2 }} size="small">
          <Descriptions.Item label="客户">
            <CustomerLink customer={o.customer} />
          </Descriptions.Item>
          <Descriptions.Item label="类型">
            <OrderKindTag kind={o.kind} />
          </Descriptions.Item>
          <Descriptions.Item label="商品">
            <Space size={4}>
              {o.planName} {termLabel(o.termMonths)}
              <FulfillmentTag type={o.fulfillmentType} />
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="Claude 账号">
            {o.accountEmail ?? '开通时分配'}
          </Descriptions.Item>
          <Descriptions.Item label="售价">
            <Money cents={o.listPriceCents} />
            {o.discountCents > 0 && (
              <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                优惠 {formatCents(o.discountCents)}
              </Typography.Text>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="质保">
            {o.withWarranty ? (
              <Space size={4}>
                <Tag color="green">已加购</Tag>
                <Money cents={o.warrantyCents} />
              </Space>
            ) : (
              <Typography.Text type="secondary">未加购</Typography.Text>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="应收 / 已收">
            <Money cents={o.amountCents} strong />
            <Typography.Text type="secondary"> / </Typography.Text>
            <Money cents={o.paidCents} />
            {o.refundedCents > 0 && (
              <Typography.Text type="danger" style={{ marginLeft: 8 }}>
                已退 {formatCents(o.refundedCents)}
              </Typography.Text>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="订阅">
            {o.subscription ? (
              <Link to={`/subscriptions/${o.subscription.id}`}>{o.subscription.code}</Link>
            ) : (
              '开通后生成'
            )}
          </Descriptions.Item>
          <Descriptions.Item label="负责客服">{o.owner.displayName}</Descriptions.Item>
          {o.agent && (
            <Descriptions.Item label="代理">
              <Space direction="vertical" size={0}>
                <Space size={4} wrap>
                  <AgentLink agent={o.agent} />
                  {o.firstOrder && <Tag color="blue">首单</Tag>}
                  {o.agentRateBp !== null && <span>佣金 {formatRate(o.agentRateBp)}</span>}
                </Space>
                {o.parentAgent && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    上级 {o.parentAgent.name}
                    {o.parentRateBp !== null && ` · 管理佣金 ${formatRate(o.parentRateBp)}`}
                  </Typography.Text>
                )}
                {o.commissionBaseCents !== null && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    佣金基数 {formatCents(o.commissionBaseCents)}
                  </Typography.Text>
                )}
              </Space>
            </Descriptions.Item>
          )}
          <Descriptions.Item label="录入">
            {o.createdBy.displayName} · {formatTime(o.createdAt)}
          </Descriptions.Item>
          <Descriptions.Item label="收齐款">{formatTime(o.paidAt)}</Descriptions.Item>
          <Descriptions.Item label="完成">{formatTime(o.completedAt)}</Descriptions.Item>
          {o.cancelledAt && (
            <Descriptions.Item label="取消">
              {formatTime(o.cancelledAt)}：{o.cancelReason}
            </Descriptions.Item>
          )}
          {o.remark && <Descriptions.Item label="备注">{o.remark}</Descriptions.Item>}
        </Descriptions>
      </Card>

      <Card title="收款记录" size="small">
        <Table<Schemas['PaymentDto']>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={o.payments}
          locale={{ emptyText: '还没有收款' }}
          scroll={{ x: 600 }}
          columns={[
            {
              title: '金额',
              key: 'amount',
              render: (_, p) => <Money cents={p.amountCents} strong />,
            },
            { title: '方式', key: 'method', render: (_, p) => METHOD_LABELS[p.method] ?? p.method },
            ...(o.profit
              ? [
                  {
                    title: '手续费',
                    key: 'fee',
                    render: (_: unknown, p: Schemas['PaymentDto']) =>
                      p.feeCents ? formatCents(p.feeCents) : '—',
                  },
                ]
              : []),
            { title: '单号 / 备注', key: 'ref', render: (_, p) => p.reference ?? '—' },
            { title: '到账时间', key: 'receivedAt', render: (_, p) => formatTime(p.receivedAt) },
            { title: '确认人', key: 'by', render: (_, p) => p.confirmedBy.displayName },
          ]}
        />
      </Card>

      <Card title="履约任务" size="small">
        <Table<Schemas['TaskBriefDto']>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={o.tasks}
          locale={{
            emptyText:
              o.kind === 'RENEWAL' && o.status === 'COMPLETED'
                ? '同套餐自动续费，已直接延长服务期'
                : '收齐款后自动生成',
          }}
          scroll={{ x: 600 }}
          columns={[
            { title: '任务', key: 'code', render: (_, t) => t.code },
            { title: '类型', key: 'type', render: (_, t) => <TaskTypeTag type={t.type} /> },
            { title: '状态', key: 'status', render: (_, t) => <TaskStatusTag status={t.status} /> },
            {
              title: '处理人',
              key: 'assignee',
              render: (_, t) => t.assignee?.displayName ?? '任务池',
            },
            { title: '最晚完成', key: 'dueAt', render: (_, t) => formatTime(t.dueAt) },
            { title: '备注', key: 'note', render: (_, t) => t.note ?? '—' },
          ]}
        />
      </Card>

      {o.refunds.length > 0 && (
        <Card title="退款" size="small">
          <RefundTable refunds={o.refunds} />
        </Card>
      )}

      {o.profit && <ProfitCard profit={o.profit} status={o.status} />}

      {refunding && (
        <RefundRequestModal
          order={o}
          refundableCents={o.refundableCents}
          onClose={() => setRefunding(false)}
        />
      )}

      {paying && (
        <PaymentModal
          orderId={o.id}
          remaining={remaining}
          onClose={() => setPaying(false)}
          onDone={refresh}
        />
      )}
    </Space>
  );
}

interface PaymentForm {
  amount: number;
  method: PaymentMethod;
  reference?: string;
  receivedAt?: Dayjs;
}

function PaymentModal({
  orderId,
  remaining,
  onClose,
  onDone,
}: {
  orderId: string;
  remaining: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<PaymentForm>();
  const pay = useMutation({
    mutationFn: (v: PaymentForm) =>
      unwrap(
        api.POST('/api/orders/{id}/payments', {
          params: { path: { id: orderId } },
          body: {
            amountCents: Math.round(v.amount * 100),
            method: v.method,
            reference: v.reference || undefined,
            receivedAt: v.receivedAt?.toISOString(),
          },
        }),
      ),
    onSuccess: (o) => {
      message.success(o.status === 'PENDING_PAYMENT' ? '已记录部分收款' : '已收齐，开通任务已派出');
      onDone();
      onClose();
    },
  });
  return (
    <Modal
      open
      title="确认收款"
      okText="确认"
      confirmLoading={pay.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Form<PaymentForm>
        form={form}
        layout="vertical"
        initialValues={{ amount: remaining / 100, method: 'wechat', receivedAt: dayjs() }}
        onFinish={(v) => pay.mutate(v)}
      >
        <Form.Item
          name="amount"
          label="收款金额（元）"
          rules={[{ required: true, message: '请输入金额' }]}
          extra={`还差 ${formatCents(remaining)}；可以分多次收`}
        >
          <InputNumber
            min={0.01}
            max={remaining / 100}
            precision={2}
            prefix="¥"
            style={{ width: '100%' }}
          />
        </Form.Item>
        <Form.Item name="method" label="收款方式">
          <Select options={PAYMENT_METHODS.map((m) => ({ value: m.value, label: m.label }))} />
        </Form.Item>
        <Form.Item name="reference" label="转账单号 / 备注">
          <Input maxLength={200} />
        </Form.Item>
        <Form.Item name="receivedAt" label="到账时间">
          <DatePicker showTime style={{ width: '100%' }} disabledDate={(d) => d.isAfter(dayjs())} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** 成本与毛利：只有有「查看成本」权限的人能看到 */
function ProfitCard({
  profit: p,
  status,
}: {
  profit: Schemas['OrderProfitDto'];
  status: Schemas['OrderDto']['status'];
}) {
  const pending = p.chargesExpected - p.chargesDone;
  return (
    <Card title="成本与毛利" size="small">
      <Row gutter={[16, 16]}>
        <Col xs={12} md={4}>
          <Statistic title="已收" value={formatCents(p.revenueCents)} />
        </Col>
        {p.refundedCents > 0 && (
          <Col xs={12} md={4}>
            <Statistic
              title="已退款"
              value={formatCents(p.refundedCents)}
              valueStyle={{ color: '#cf1322' }}
            />
          </Col>
        )}
        <Col xs={12} md={4}>
          <Statistic title="收款手续费" value={formatCents(p.feeCents)} />
        </Col>
        <Col xs={12} md={4}>
          <Statistic title="已发生成本" value={formatCents(p.costCents)} />
        </Col>
        <Col xs={12} md={4}>
          <Statistic
            title="毛利"
            value={formatCents(p.marginCents)}
            valueStyle={p.marginCents < 0 ? { color: '#cf1322' } : { color: '#389e0d' }}
          />
        </Col>
        <Col xs={12} md={4}>
          <Statistic
            title="毛利率"
            value={p.marginRate === null ? '—' : `${(p.marginRate * 100).toFixed(1)}%`}
          />
        </Col>
        {pending > 0 && status !== 'CANCELLED' && (
          <Col xs={12} md={4}>
            <Statistic
              title={
                <Tooltip
                  title={`服务期 ${p.chargesExpected} 个月，上游按月扣费，还有 ${pending} 次没发生；按官方月费和当前汇率估算`}
                >
                  预计毛利（还要扣 {pending} 次）
                </Tooltip>
              }
              value={formatCents(p.estMarginCents)}
              valueStyle={p.estMarginCents < 0 ? { color: '#cf1322' } : undefined}
            />
          </Col>
        )}
      </Row>
      <Table<Schemas['CostEntryDto']>
        rowKey="id"
        size="small"
        style={{ marginTop: 16 }}
        pagination={false}
        dataSource={p.costs}
        locale={{ emptyText: '还没有成本记录（开通 / 续费时充值员登记上游扣费后出现）' }}
        scroll={{ x: 600 }}
        columns={[
          {
            title: '时间',
            key: 'createdAt',
            width: 150,
            render: (_, c) => formatTime(c.createdAt),
          },
          { title: '类型', key: 'kind', width: 100, render: (_, c) => COST_KIND_LABELS[c.kind] },
          {
            title: '成本',
            key: 'amount',
            render: (_, c) => (
              <Space size={4}>
                <Money cents={c.amountCents} />
                {c.usdCents !== null && (
                  <Typography.Text type="secondary">
                    （{formatCents(c.usdCents, '$')}）
                  </Typography.Text>
                )}
              </Space>
            ),
          },
          { title: '付款资源', key: 'resource', render: (_, c) => c.resourceName ?? '—' },
          { title: '说明', key: 'note', render: (_, c) => c.note ?? '—' },
          { title: '登记人', key: 'user', width: 90, render: (_, c) => c.user.displayName },
        ]}
      />
    </Card>
  );
}
