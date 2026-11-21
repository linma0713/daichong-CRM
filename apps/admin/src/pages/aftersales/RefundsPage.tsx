import { useState } from 'react';
import { Link } from 'react-router';
import {
  App,
  Badge,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  type TableColumnsType,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import { PAYMENT_METHODS, formatCents, type PaymentMethod, type RefundStatus } from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { CustomerLink, Money, RefundStatusTag } from '../../components/business';
import { formatTime } from '../../components/format';
import { useAftersalesRefresh } from './modals';

type Refund = Schemas['RefundDto'];
type View = RefundStatus | 'all';
const METHOD_LABELS = Object.fromEntries(PAYMENT_METHODS.map((m) => [m.value, m.label]));

export function RefundsPage() {
  const { can } = useAuth();
  const approver = can('refund:approve');
  const [view, setView] = useState<View>('PENDING');
  const [filters, setFilters] = useState<{ page: number; pageSize: number; keyword?: string }>({
    page: 1,
    pageSize: 20,
  });
  const [reviewing, setReviewing] = useState<{ refund: Refund; action: 'approve' | 'reject' }>();
  const query = { ...filters, status: view === 'all' ? undefined : view };
  const refunds = useQuery({
    queryKey: ['refunds', query],
    queryFn: () => unwrap(api.GET('/api/refunds', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const dashboard = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => unwrap(api.GET('/api/dashboard')),
  });
  const pending = dashboard.data?.aftersales?.pendingRefunds;

  const columns: TableColumnsType<Refund> = [
    {
      title: '退款',
      key: 'code',
      width: 110,
      render: (_, r) => (
        <Space direction="vertical" size={2}>
          <span>{r.code}</span>
          <RefundStatusTag status={r.status} />
        </Space>
      ),
    },
    {
      title: '客户',
      key: 'customer',
      width: 150,
      render: (_, r) => <CustomerLink customer={r.customer} />,
    },
    {
      title: '金额',
      key: 'amount',
      width: 170,
      render: (_, r) => (
        <Space direction="vertical" size={0}>
          <Money cents={r.amountCents} strong />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            订单已收 {formatCents(r.orderPaidCents)}
            {r.orderRefundedCents > 0 && `，已退 ${formatCents(r.orderRefundedCents)}`}
          </Typography.Text>
          {r.commissionReducedCents > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              扣减代理佣金 {formatCents(r.commissionReducedCents)}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: '原因',
      key: 'reason',
      render: (_, r) => (
        <Space direction="vertical" size={0} style={{ fontSize: 13 }}>
          <span>{r.reason}</span>
          <Space size={8} wrap style={{ fontSize: 12 }}>
            <Link to={`/orders/${r.order.id}`}>订单 {r.order.code}</Link>
            {r.ticket && <Link to={`/tickets/${r.ticket.id}`}>工单 {r.ticket.code}</Link>}
            {r.terminate && <Tag color="red">退款后终止服务</Tag>}
          </Space>
          {r.rejectReason && (
            <Typography.Text type="secondary">驳回：{r.rejectReason}</Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: '申请',
      key: 'requested',
      width: 150,
      render: (_, r) => (
        <Space direction="vertical" size={0} style={{ fontSize: 12 }}>
          <span>{r.requestedBy.displayName}</span>
          <Typography.Text type="secondary">{formatTime(r.createdAt)}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '审批 / 出账',
      key: 'approved',
      width: 170,
      render: (_, r) =>
        r.status === 'PENDING' ? (
          approver ? (
            <Space size={0}>
              <Button
                type="link"
                size="small"
                onClick={() => setReviewing({ refund: r, action: 'approve' })}
              >
                通过并出账
              </Button>
              <Button
                type="link"
                size="small"
                danger
                onClick={() => setReviewing({ refund: r, action: 'reject' })}
              >
                驳回
              </Button>
            </Space>
          ) : (
            <Typography.Text type="secondary">等财务审批</Typography.Text>
          )
        ) : (
          <Space direction="vertical" size={0} style={{ fontSize: 12 }}>
            <span>{r.approvedBy?.displayName ?? '—'}</span>
            {r.paidAt && (
              <Typography.Text type="secondary">
                {formatTime(r.paidAt)} · {METHOD_LABELS[r.method ?? ''] ?? r.method}
                {r.reference ? ` · ${r.reference}` : ''}
              </Typography.Text>
            )}
          </Space>
        ),
    },
  ];

  return (
    <Card title="退款审批">
      <Tabs
        activeKey={view}
        onChange={(k) => {
          setView(k as View);
          setFilters((f) => ({ ...f, page: 1 }));
        }}
        items={[
          {
            key: 'PENDING',
            label: (
              <Space size={6}>
                待审批
                {pending ? <Badge count={pending} color="orange" /> : null}
              </Space>
            ),
          },
          { key: 'PAID', label: '已退款' },
          { key: 'REJECTED', label: '已驳回' },
          { key: 'all', label: '全部' },
        ]}
      />
      <div className="page-toolbar">
        <div className="page-toolbar-filters">
          <Input.Search
            placeholder="退款编号、客户称呼"
            allowClear
            style={{ width: 240 }}
            onSearch={(keyword) =>
              setFilters((f) => ({ ...f, page: 1, keyword: keyword || undefined }))
            }
          />
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void refunds.refetch()}>
          刷新
        </Button>
      </div>
      <Table<Refund>
        rowKey="id"
        columns={columns}
        dataSource={refunds.data?.items}
        loading={refunds.isFetching}
        scroll={{ x: 1000 }}
        pagination={{
          current: filters.page,
          pageSize: filters.pageSize,
          total: refunds.data?.total,
          showSizeChanger: true,
          showTotal: (total: number) => `共 ${total} 笔`,
          onChange: (page: number, pageSize: number) =>
            setFilters((f) => ({ ...f, page, pageSize })),
        }}
      />
      {reviewing && (
        <ReviewModal
          refund={reviewing.refund}
          action={reviewing.action}
          onClose={() => setReviewing(undefined)}
        />
      )}
    </Card>
  );
}

interface ReviewForm {
  method?: PaymentMethod;
  reference?: string;
  paidAt?: Dayjs;
  reason?: string;
}

function ReviewModal({
  refund: r,
  action,
  onClose,
}: {
  refund: Refund;
  action: 'approve' | 'reject';
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const refresh = useAftersalesRefresh();
  const [form] = Form.useForm<ReviewForm>();
  const approve = action === 'approve';
  const submit = useMutation({
    mutationFn: (v: ReviewForm) =>
      unwrap(
        approve
          ? api.POST('/api/refunds/{id}/approve', {
              params: { path: { id: r.id } },
              body: {
                method: v.method!,
                reference: v.reference?.trim() || undefined,
                paidAt: v.paidAt?.toISOString(),
              },
            })
          : api.POST('/api/refunds/{id}/reject', {
              params: { path: { id: r.id } },
              body: { reason: v.reason!.trim() },
            }),
      ),
    onSuccess: () => {
      message.success(approve ? `${r.code} 已出账` : `${r.code} 已驳回`);
      refresh();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`${approve ? '通过并出账' : '驳回退款'}：${r.code}`}
      okText={approve ? '确认已退款' : '驳回'}
      okButtonProps={{ danger: !approve }}
      confirmLoading={submit.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Descriptions column={1} size="small" style={{ marginBottom: 16 }}>
        <Descriptions.Item label="客户">
          {r.customer.name}（{r.customer.code}）
        </Descriptions.Item>
        <Descriptions.Item label="订单">
          {r.order.code} · 已收 {formatCents(r.orderPaidCents)}
          {r.orderRefundedCents > 0 && `，已退 ${formatCents(r.orderRefundedCents)}`}
        </Descriptions.Item>
        <Descriptions.Item label="退款金额">
          <Money cents={r.amountCents} strong />
        </Descriptions.Item>
        <Descriptions.Item label="原因">{r.reason}</Descriptions.Item>
        {r.terminate && (
          <Descriptions.Item label="终止服务">
            <Typography.Text type="danger">
              通过后订阅终止，并自动派取消自动续订 / 回收成品号任务
            </Typography.Text>
          </Descriptions.Item>
        )}
      </Descriptions>
      <Form<ReviewForm>
        form={form}
        layout="vertical"
        initialValues={{ method: 'wechat', paidAt: dayjs() }}
        onFinish={(v) => submit.mutate(v)}
      >
        {approve ? (
          <>
            <Form.Item name="method" label="退款方式" rules={[{ required: true }]}>
              <Select options={PAYMENT_METHODS.map((m) => ({ value: m.value, label: m.label }))} />
            </Form.Item>
            <Form.Item name="reference" label="退款单号 / 备注">
              <Input maxLength={200} />
            </Form.Item>
            <Form.Item name="paidAt" label="退款时间">
              <DatePicker
                showTime
                style={{ width: '100%' }}
                disabledDate={(d) => d.isAfter(dayjs())}
              />
            </Form.Item>
          </>
        ) : (
          <Form.Item
            name="reason"
            label="驳回原因"
            rules={[{ required: true, whitespace: true, message: '请填写驳回原因' }]}
          >
            <Input.TextArea rows={3} maxLength={500} />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}
