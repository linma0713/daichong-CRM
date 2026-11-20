import { useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  Alert,
  App,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Result,
  Select,
  Space,
  Spin,
  Table,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import { PAYMENT_METHODS, formatCents, termLabel, type PaymentMethod } from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import {
  CustomerLink,
  FulfillmentTag,
  Money,
  OrderKindTag,
  OrderStatusTag,
  TaskStatusTag,
  TaskTypeTag,
} from '../../components/business';
import { formatTime } from '../../components/format';

const METHOD_LABELS = Object.fromEntries(PAYMENT_METHODS.map((m) => [m.value, m.label]));

export function OrderDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const { modal, message } = App.useApp();
  const queryClient = useQueryClient();
  const [paying, setPaying] = useState(false);
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
          <Descriptions.Item label="应收 / 已收">
            <Money cents={o.amountCents} strong />
            <Typography.Text type="secondary"> / </Typography.Text>
            <Money cents={o.paidCents} />
          </Descriptions.Item>
          <Descriptions.Item label="订阅">
            {o.subscription ? (
              <Link to={`/subscriptions/${o.subscription.id}`}>{o.subscription.code}</Link>
            ) : (
              '开通后生成'
            )}
          </Descriptions.Item>
          <Descriptions.Item label="负责客服">{o.owner.displayName}</Descriptions.Item>
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
