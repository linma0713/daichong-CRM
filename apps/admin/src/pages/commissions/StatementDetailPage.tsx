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
  Modal,
  Result,
  Row,
  Select,
  Space,
  Spin,
  Statistic,
  Steps,
  Table,
  Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import { PAYMENT_METHODS, formatCents, receiptMethodLabel, type PaymentMethod } from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import {
  AgentLink,
  CustomerLink,
  Money,
  PayableText,
  StatementStatusTag,
} from '../../components/business';
import { formatTime } from '../../components/format';
import { CommissionTable } from './CommissionTable';

type Detail = Schemas['StatementDetailDto'];
type Payment = Schemas['StatementPaymentDto'];

const STEP: Record<Detail['status'], number> = { DRAFT: 0, CONFIRMED: 1, PAID: 2, CANCELLED: 0 };

export function StatementDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<'confirm' | 'pay' | 'cancel' | null>(null);
  const statement = useQuery({
    queryKey: ['commission-statement', id],
    queryFn: () => unwrap(api.GET('/api/commission-statements/{id}', { params: { path: { id } } })),
  });
  const done = (d?: Detail) => {
    if (d) queryClient.setQueryData(['commission-statement', id], d);
    void queryClient.invalidateQueries({ queryKey: ['commission-statements'] });
    void queryClient.invalidateQueries({ queryKey: ['commissions'] });
    setDialog(null);
  };
  const refresh = useMutation({
    mutationFn: (s: Detail) =>
      unwrap(
        api.POST('/api/commission-statements/generate', {
          body: { month: s.month, agentId: s.agent.id },
        }),
      ),
    onSuccess: () => {
      message.success('已补进新的明细');
      void statement.refetch();
      done();
    },
  });

  if (statement.isLoading) return <Spin style={{ display: 'block', margin: 48 }} />;
  if (!statement.data) return <Result status="404" title="对账单不存在" />;
  const s = statement.data;
  const settle = can('commission:settle');
  const open = s.status === 'DRAFT' || s.status === 'CONFIRMED';

  const paymentColumns = [
    {
      title: '订单',
      key: 'order',
      render: (_: unknown, p: Payment) => <Link to={`/orders/${p.order.id}`}>{p.order.code}</Link>,
    },
    {
      title: '客户',
      key: 'customer',
      render: (_: unknown, p: Payment) => <CustomerLink customer={p.customer} />,
    },
    {
      title: '代收金额',
      key: 'amount',
      align: 'right' as const,
      render: (_: unknown, p: Payment) => <Money cents={p.amountCents} strong />,
    },
    {
      title: '收款时间',
      key: 'receivedAt',
      render: (_: unknown, p: Payment) => formatTime(p.receivedAt),
    },
    {
      title: '备注',
      key: 'ref',
      render: (_: unknown, p: Payment) => p.reference ?? '—',
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space>
            <span>佣金对账单 {s.code}</span>
            <StatementStatusTag status={s.status} />
          </Space>
        }
        extra={
          <Space wrap>
            <Button icon={<ReloadOutlined />} onClick={() => void statement.refetch()}>
              刷新
            </Button>
            {settle && s.status === 'DRAFT' && (
              <>
                <Button loading={refresh.isPending} onClick={() => refresh.mutate(s)}>
                  补进新明细
                </Button>
                <Button type="primary" onClick={() => setDialog('confirm')}>
                  确认对账
                </Button>
              </>
            )}
            {settle && s.status === 'CONFIRMED' && (
              <Button type="primary" onClick={() => setDialog('pay')}>
                {s.payableCents < 0
                  ? '登记代理补交'
                  : s.payableCents === 0
                    ? '标记结清'
                    : '登记打款'}
              </Button>
            )}
            {settle && open && (
              <Button danger onClick={() => setDialog('cancel')}>
                作废
              </Button>
            )}
          </Space>
        }
      >
        {s.status === 'CANCELLED' ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            message={`已作废（${formatTime(s.cancelledAt)}）`}
            description={`原因：${s.note ?? '—'}。里面的佣金和代收款已退回，下次出单会重新收录。`}
          />
        ) : (
          <Steps
            size="small"
            style={{ marginBottom: 20, maxWidth: 640 }}
            current={STEP[s.status]}
            status={s.status === 'PAID' ? 'finish' : 'process'}
            items={[
              { title: '待确认', description: '可以补进新明细' },
              { title: '待打款', description: '金额已定' },
              { title: '已结清' },
            ]}
          />
        )}
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={12} md={6}>
            <Statistic title="佣金合计（含扣回）" value={formatCents(s.commissionCents)} />
          </Col>
          <Col xs={12} md={6}>
            <Statistic
              title="代理代收抵扣"
              value={s.collectedCents ? `− ${formatCents(s.collectedCents)}` : '—'}
            />
          </Col>
          <Col xs={24} md={12}>
            <Statistic
              title={
                s.payableCents < 0 ? '代理要补交给我们（代收 − 佣金）' : '应付代理（佣金 − 代收）'
              }
              value={formatCents(Math.abs(s.payableCents))}
              valueStyle={{ fontWeight: 600, color: s.payableCents < 0 ? '#cf1322' : undefined }}
            />
          </Col>
        </Row>
        <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered>
          <Descriptions.Item label="代理">
            <AgentLink agent={s.agent} />
          </Descriptions.Item>
          <Descriptions.Item label="对账月份">{s.month}</Descriptions.Item>
          <Descriptions.Item label="代理收款账户">
            {s.payout.method || s.payout.account ? (
              <Typography.Text copyable={s.payout.account ? { text: s.payout.account } : false}>
                {receiptMethodLabel(s.payout.method)} {s.payout.account ?? ''}
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary">没填，去代理资料里补上</Typography.Text>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="收录截止">{formatTime(s.cutoffAt)}</Descriptions.Item>
          <Descriptions.Item label="生成">
            {s.createdBy ? `${s.createdBy.displayName} 手动生成` : '每月 1 号自动生成'} ·{' '}
            {formatTime(s.createdAt)}
          </Descriptions.Item>
          <Descriptions.Item label="确认">
            {s.confirmedBy ? `${s.confirmedBy.displayName} · ${formatTime(s.confirmedAt)}` : '—'}
          </Descriptions.Item>
          <Descriptions.Item label={s.payableCents < 0 ? '补交' : '打款'}>
            {s.paidBy ? (
              <Space direction="vertical" size={0}>
                <span>
                  {s.paidBy.displayName} · {formatTime(s.paidAt)}
                </span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {[s.payMethod ? receiptMethodLabel(s.payMethod) : null, s.payReference]
                    .filter(Boolean)
                    .join(' · ') || '应付为 0，直接结清'}
                </Typography.Text>
              </Space>
            ) : (
              '—'
            )}
          </Descriptions.Item>
          {s.status !== 'CANCELLED' && (
            <Descriptions.Item label="备注">{s.note ?? '—'}</Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      <Card title={`佣金明细（${s.commissions.length}）`} size="small">
        <CommissionTable
          data={s.commissions}
          hideAgent
          emptyText={s.status === 'CANCELLED' ? '已作废，明细已退回' : '没有佣金明细'}
        />
      </Card>

      <Card title={`代理代收的款（${s.payments.length}）`} size="small">
        <Typography.Paragraph type="secondary">
          客户直接付给代理的钱：已经算进订单收款，在这里从佣金里抵扣，多退少补。
        </Typography.Paragraph>
        <Table<Payment>
          rowKey="id"
          size="small"
          pagination={false}
          columns={paymentColumns}
          dataSource={s.payments}
          scroll={{ x: 600 }}
          locale={{ emptyText: '没有代收款' }}
        />
      </Card>

      {dialog === 'confirm' && (
        <ConfirmModal statement={s} onClose={() => setDialog(null)} onDone={done} />
      )}
      {dialog === 'pay' && <PayModal statement={s} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'cancel' && (
        <CancelModal statement={s} onClose={() => setDialog(null)} onDone={done} />
      )}
    </Space>
  );
}

interface ModalProps {
  statement: Detail;
  onClose: () => void;
  onDone: (d: Detail) => void;
}

function ConfirmModal({ statement: s, onClose, onDone }: ModalProps) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ note?: string }>();
  const confirm = useMutation({
    mutationFn: (v: { note?: string }) =>
      unwrap(
        api.POST('/api/commission-statements/{id}/confirm', {
          params: { path: { id: s.id } },
          body: { note: v.note || undefined },
        }),
      ),
    onSuccess: (d) => {
      message.success('已确认，金额已定下来');
      onDone(d);
    },
  });
  return (
    <Modal
      open
      title={`确认对账单 ${s.code}`}
      okText="确认对账"
      confirmLoading={confirm.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Typography.Paragraph>
        和代理 {s.agent.name}{' '}
        核对过下面的明细后再确认。确认后金额定下来，之后的退款记成「扣回」放到下个月。
      </Typography.Paragraph>
      <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
        <Descriptions.Item label="佣金合计">{formatCents(s.commissionCents)}</Descriptions.Item>
        <Descriptions.Item label="代收抵扣">{formatCents(s.collectedCents)}</Descriptions.Item>
        <Descriptions.Item label={s.payableCents < 0 ? '代理补交' : '应付代理'}>
          <PayableText cents={s.payableCents} strong />
        </Descriptions.Item>
      </Descriptions>
      <Form form={form} layout="vertical" onFinish={(v) => confirm.mutate(v)}>
        <Form.Item name="note" label="备注">
          <Input.TextArea rows={2} maxLength={500} placeholder="比如：已和代理微信核对" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

interface PayForm {
  method?: PaymentMethod;
  reference?: string;
  paidAt?: Dayjs;
}

function PayModal({ statement: s, onClose, onDone }: ModalProps) {
  const { message } = App.useApp();
  const [form] = Form.useForm<PayForm>();
  const owe = s.payableCents < 0;
  const zero = s.payableCents === 0;
  const defaultMethod = PAYMENT_METHODS.some((m) => m.value === s.payout.method)
    ? (s.payout.method as PaymentMethod)
    : undefined;
  const pay = useMutation({
    mutationFn: (v: PayForm) =>
      unwrap(
        api.POST('/api/commission-statements/{id}/pay', {
          params: { path: { id: s.id } },
          body: {
            method: v.method,
            reference: v.reference || undefined,
            paidAt: v.paidAt?.toISOString(),
          },
        }),
      ),
    onSuccess: (d) => {
      message.success('已结清');
      onDone(d);
    },
  });
  return (
    <Modal
      open
      title={
        owe ? `登记代理补交 · ${s.code}` : zero ? `标记结清 · ${s.code}` : `登记打款 · ${s.code}`
      }
      okText="确认结清"
      confirmLoading={pay.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Alert
        type={owe ? 'warning' : 'info'}
        showIcon
        style={{ marginBottom: 16 }}
        message={
          owe
            ? `代理 ${s.agent.name} 代收的钱比佣金多，要补交 ${formatCents(-s.payableCents)} 给我们`
            : zero
              ? '佣金正好抵完代收款，不用打款'
              : `给代理 ${s.agent.name} 打款 ${formatCents(s.payableCents)}`
        }
        description={
          !owe && !zero && (s.payout.method || s.payout.account)
            ? `收款账户：${receiptMethodLabel(s.payout.method)} ${s.payout.account ?? ''}`
            : undefined
        }
      />
      <Form<PayForm>
        form={form}
        layout="vertical"
        initialValues={{ method: owe ? undefined : defaultMethod, paidAt: dayjs() }}
        onFinish={(v) => pay.mutate(v)}
      >
        {!zero && (
          <Form.Item
            name="method"
            label={owe ? '代理补交到我们的哪个账户' : '打款方式'}
            rules={[{ required: true, message: '请选择' }]}
          >
            <Select options={PAYMENT_METHODS.map((m) => ({ value: m.value, label: m.label }))} />
          </Form.Item>
        )}
        <Form.Item name="reference" label="转账单号 / 备注">
          <Input maxLength={200} />
        </Form.Item>
        <Form.Item name="paidAt" label={owe ? '到账时间' : '打款时间'}>
          <DatePicker showTime style={{ width: '100%' }} disabledDate={(d) => d.isAfter(dayjs())} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function CancelModal({ statement: s, onClose, onDone }: ModalProps) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ reason: string }>();
  const cancel = useMutation({
    mutationFn: (v: { reason: string }) =>
      unwrap(
        api.POST('/api/commission-statements/{id}/cancel', {
          params: { path: { id: s.id } },
          body: { reason: v.reason },
        }),
      ),
    onSuccess: (d) => {
      message.success('已作废，明细已退回可结算');
      onDone(d);
    },
  });
  return (
    <Modal
      open
      title={`作废对账单 ${s.code}`}
      okText="作废"
      okButtonProps={{ danger: true }}
      confirmLoading={cancel.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Typography.Paragraph>
        作废后里面的佣金退回「可结算」、代收款退回未抵扣，重新生成时会另出一张单。
      </Typography.Paragraph>
      <Form form={form} layout="vertical" onFinish={(v) => cancel.mutate(v)}>
        <Form.Item
          name="reason"
          label="作废原因"
          rules={[{ required: true, whitespace: true, message: '请填写作废原因' }]}
        >
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
