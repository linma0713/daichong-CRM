import { useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  Alert,
  App,
  Button,
  Card,
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
  Tag,
  Timeline,
  Typography,
} from 'antd';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CUSTOMER_FAULTS, PAYMENT_METHODS, TICKET_STATUS_LABELS } from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { useStaffOptions } from '../../api/queries';
import { useAuth } from '../../auth/AuthProvider';
import {
  CustomerLink,
  FulfillmentTag,
  Money,
  RefundStatusTag,
  SubscriptionStatusTag,
  TaskStatusTag,
  TaskTypeTag,
  TicketStatusTag,
  TicketTypeTag,
  WarrantyAlert,
} from '../../components/business';
import { formatTime } from '../../components/format';
import { RefundRequestModal, useAftersalesRefresh } from './modals';
import { Attachments, AttachmentsButton } from '../../components/attachments';

type Ticket = Schemas['TicketDetailDto'];
type TextAction = 'replace' | 'resolve' | 'close' | 'reopen';

const EVENT_LABELS: Record<string, { label: string; color: string }> = {
  created: { label: '登记', color: 'blue' },
  comment: { label: '备注', color: 'gray' },
  status: { label: '状态', color: 'blue' },
  assign: { label: '指派', color: 'blue' },
  fault: { label: '客户原因', color: 'orange' },
  escalated: { label: '超时升级', color: 'red' },
  replace: { label: '换号', color: 'gold' },
  compensate: { label: '补偿', color: 'green' },
  refund: { label: '退款', color: 'purple' },
  resolved: { label: '已解决', color: 'green' },
  closed: { label: '关闭', color: 'gray' },
  reopened: { label: '重新打开', color: 'orange' },
};
const METHOD_LABELS = Object.fromEntries(PAYMENT_METHODS.map((m) => [m.value, m.label]));
const UNRESOLVED = ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER'];

export function TicketDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const { message } = App.useApp();
  const refresh = useAftersalesRefresh();
  const staff = useStaffOptions();
  const [action, setAction] = useState<TextAction | null>(null);
  const [compensating, setCompensating] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [comment, setComment] = useState('');
  const ticket = useQuery({
    queryKey: ['ticket', id],
    queryFn: () => unwrap(api.GET('/api/tickets/{id}', { params: { path: { id } } })),
  });
  const update = useMutation({
    mutationFn: (body: Schemas['UpdateTicketDto']) =>
      unwrap(api.PATCH('/api/tickets/{id}', { params: { path: { id } }, body })),
    onSuccess: () => {
      message.success('已更新');
      refresh();
    },
  });
  const addComment = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/tickets/{id}/comments', {
          params: { path: { id } },
          body: { content: comment.trim() },
        }),
      ),
    onSuccess: () => {
      setComment('');
      refresh();
    },
  });

  if (ticket.isLoading) return <Spin style={{ display: 'block', margin: 48 }} />;
  if (!ticket.data) return <Result status="404" title="工单不存在或你没有权限查看" />;
  const t = ticket.data;
  const handler = can('ticket:handle');
  const open = UNRESOLVED.includes(t.status);
  const subActive = t.subscription?.status === 'ACTIVE';

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title={
          <Space wrap>
            工单 {t.code}
            <TicketTypeTag type={t.type} />
            <TicketStatusTag status={t.status} />
            {t.overdue && <Tag color="red">已超时</Tag>}
            {t.escalatedAt && <Tag color="volcano">已升级</Tag>}
          </Space>
        }
        extra={
          <Space wrap>
            {handler && open && subActive && (
              <Button onClick={() => setAction('replace')}>换号</Button>
            )}
            {handler && open && subActive && (
              <Button onClick={() => setCompensating(true)}>补偿天数</Button>
            )}
            {handler && t.order && t.refundableCents > 0 && (
              <Button onClick={() => setRefunding(true)}>申请退款</Button>
            )}
            {handler && open && (
              <Button type="primary" onClick={() => setAction('resolve')}>
                标记已解决
              </Button>
            )}
            {handler && t.status !== 'CLOSED' && (
              <Button onClick={() => setAction('close')}>关闭</Button>
            )}
            {!open && <Button onClick={() => setAction('reopen')}>重新打开</Button>}
          </Space>
        }
      >
        <Descriptions column={{ xs: 1, sm: 1, md: 2, lg: 2, xl: 2, xxl: 2 }} size="small">
          <Descriptions.Item label="客户">
            <CustomerLink customer={t.customer} />
          </Descriptions.Item>
          <Descriptions.Item label="订阅">
            {t.subscription ? (
              <Space size={4} wrap>
                <Link to={`/subscriptions/${t.subscription.id}`}>{t.subscription.code}</Link>
                {t.subscription.planName}
                <FulfillmentTag type={t.subscription.fulfillmentType} />
                <SubscriptionStatusTag status={t.subscription.status} />
                <Typography.Text type="secondary">
                  {t.subscription.accountEmail} · 服务到 {formatTime(t.subscription.endAt)}
                </Typography.Text>
              </Space>
            ) : (
              '未关联'
            )}
          </Descriptions.Item>
          <Descriptions.Item label="问题描述" span="filled">
            <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>{t.description}</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="处理人">
            {handler && open ? (
              <Select
                size="small"
                style={{ minWidth: 160 }}
                value={t.assignee?.id ?? '__none'}
                loading={update.isPending}
                onChange={(v: string) => update.mutate({ assigneeId: v === '__none' ? null : v })}
                options={[
                  { value: '__none', label: '待领取' },
                  ...(staff.data ?? [])
                    .filter((s) => s.canHandleTickets)
                    .map((s) => ({ value: s.id, label: s.displayName })),
                ]}
              />
            ) : (
              (t.assignee?.displayName ?? '待领取')
            )}
          </Descriptions.Item>
          <Descriptions.Item label="状态">
            {handler && open ? (
              <Select<Schemas['UpdateTicketDto']['status']>
                size="small"
                style={{ minWidth: 140 }}
                value={t.status as Schemas['UpdateTicketDto']['status']}
                loading={update.isPending}
                onChange={(status: Schemas['UpdateTicketDto']['status']) =>
                  update.mutate({ status })
                }
                options={(['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER'] as const).map((s) => ({
                  value: s,
                  label: TICKET_STATUS_LABELS[s],
                }))}
              />
            ) : (
              <TicketStatusTag status={t.status} />
            )}
          </Descriptions.Item>
          <Descriptions.Item label="客户原因">
            {handler ? (
              <Select
                size="small"
                allowClear
                placeholder="无（不是客户的原因）"
                style={{ minWidth: 200 }}
                value={t.customerFault ?? undefined}
                loading={update.isPending}
                onChange={(v?: Schemas['UpdateTicketDto']['customerFault']) =>
                  update.mutate({ customerFault: v ?? null })
                }
                options={CUSTOMER_FAULTS.map((f) => ({ value: f.value, label: f.label }))}
              />
            ) : (
              (t.customerFaultLabel ?? '无')
            )}
          </Descriptions.Item>
          <Descriptions.Item label="处理时限">
            {formatTime(t.dueAt)}
            {t.status === 'WAITING_CUSTOMER' && (
              <Typography.Text type="secondary">（等客户回复期间不算超时）</Typography.Text>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="登记">
            {t.createdBy.displayName} · {formatTime(t.createdAt)}
          </Descriptions.Item>
          <Descriptions.Item label="客户负责人">{t.owner.displayName}</Descriptions.Item>
          {t.resolution && (
            <Descriptions.Item label="处理结果" span="filled">
              {t.resolution}（{formatTime(t.resolvedAt)}）
            </Descriptions.Item>
          )}
        </Descriptions>
        <div style={{ marginTop: 16 }}>
          <WarrantyAlert warranty={t.warranty} />
        </div>
      </Card>

      <Card title="附件" size="small">
        <Attachments
          ownerType="ticket"
          ownerId={t.id}
          canUpload={can('ticket:create') || can('ticket:handle')}
          hint="客户发来的报错截图、封号邮件、排查截图"
        />
      </Card>

      <Card title="处理记录" size="small">
        <Timeline
          style={{ marginTop: 8 }}
          items={t.events.map((e) => {
            const meta = EVENT_LABELS[e.kind] ?? { label: e.kind, color: 'gray' };
            return {
              color: meta.color,
              children: (
                <Space direction="vertical" size={0}>
                  <Space size={8} wrap>
                    <Typography.Text strong>{meta.label}</Typography.Text>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {e.user?.displayName ?? '系统'} · {formatTime(e.createdAt)}
                    </Typography.Text>
                  </Space>
                  {e.content && (
                    <Typography.Text style={{ whiteSpace: 'pre-wrap' }}>
                      {e.content}
                    </Typography.Text>
                  )}
                </Space>
              ),
            };
          })}
        />
        <Space.Compact block>
          <Input.TextArea
            rows={2}
            maxLength={1000}
            value={comment}
            placeholder="记录和客户的沟通、排查进展"
            onChange={(e) => setComment(e.target.value)}
          />
          <Button
            type="primary"
            style={{ height: 'auto' }}
            disabled={!comment.trim()}
            loading={addComment.isPending}
            onClick={() => addComment.mutate()}
          >
            添加备注
          </Button>
        </Space.Compact>
      </Card>

      {(t.refunds.length > 0 || t.tasks.length > 0) && (
        <Card title="换号与退款" size="small">
          {t.tasks.length > 0 && (
            <Table<Schemas['TaskBriefDto']>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={t.tasks}
              scroll={{ x: 600 }}
              columns={[
                { title: '任务', key: 'code', render: (_, k) => k.code },
                { title: '类型', key: 'type', render: (_, k) => <TaskTypeTag type={k.type} /> },
                {
                  title: '状态',
                  key: 'status',
                  render: (_, k) => <TaskStatusTag status={k.status} />,
                },
                {
                  title: '充值员',
                  key: 'assignee',
                  render: (_, k) => k.assignee?.displayName ?? '任务池',
                },
                {
                  title: '完成',
                  key: 'finishedAt',
                  render: (_, k) => formatTime(k.finishedAt ?? null),
                },
                { title: '备注', key: 'note', render: (_, k) => k.note ?? '—' },
              ]}
            />
          )}
          {t.refunds.length > 0 && (
            <RefundTable refunds={t.refunds} style={{ marginTop: t.tasks.length ? 16 : 0 }} />
          )}
        </Card>
      )}

      {action && <TextActionModal ticket={t} action={action} onClose={() => setAction(null)} />}
      {compensating && <CompensateModal ticket={t} onClose={() => setCompensating(false)} />}
      {refunding && t.order && (
        <RefundRequestModal
          order={t.order}
          ticketId={t.id}
          refundableCents={t.refundableCents}
          suggestedCents={t.warranty.covered ? t.warranty.refundableCents : undefined}
          onClose={() => setRefunding(false)}
        />
      )}
    </Space>
  );
}

type RefundRow = Pick<
  Schemas['RefundDto'],
  | 'id'
  | 'code'
  | 'amountCents'
  | 'status'
  | 'reason'
  | 'terminate'
  | 'rejectReason'
  | 'requestedBy'
  | 'paidAt'
  | 'method'
>;

/** 退款记录表（工单详情、订单详情共用） */
export function RefundTable({
  refunds,
  style,
}: {
  refunds: RefundRow[];
  style?: React.CSSProperties;
}) {
  const { can } = useAuth();
  const canUpload = can('refund:approve') || can('ticket:handle');
  return (
    <Table<RefundRow>
      rowKey="id"
      size="small"
      style={style}
      pagination={false}
      dataSource={refunds}
      scroll={{ x: 700 }}
      columns={[
        { title: '退款', key: 'code', render: (_, r) => r.code },
        { title: '金额', key: 'amount', render: (_, r) => <Money cents={r.amountCents} strong /> },
        { title: '状态', key: 'status', render: (_, r) => <RefundStatusTag status={r.status} /> },
        {
          title: '原因',
          key: 'reason',
          render: (_, r) => (
            <Space direction="vertical" size={0}>
              <span>{r.reason}</span>
              {r.terminate && <Tag color="red">退款后终止服务</Tag>}
              {r.rejectReason && (
                <Typography.Text type="secondary">驳回：{r.rejectReason}</Typography.Text>
              )}
            </Space>
          ),
        },
        { title: '申请人', key: 'by', render: (_, r) => r.requestedBy.displayName },
        {
          title: '出账',
          key: 'paid',
          render: (_, r) =>
            r.paidAt
              ? `${formatTime(r.paidAt)} · ${METHOD_LABELS[r.method ?? ''] ?? r.method}`
              : '—',
        },
        {
          title: '凭证',
          key: 'files',
          render: (_, r) => (
            <AttachmentsButton
              ownerType="refund"
              ownerId={r.id}
              title={`退款凭证：${r.code}`}
              canUpload={canUpload}
              hint="退款截图、客户确认记录等"
            />
          ),
        },
      ]}
    />
  );
}

const ACTION_META: Record<
  TextAction,
  { title: string; label: string; required: boolean; ok: string; done: string }
> = {
  replace: {
    title: '派换号任务',
    label: '给充值员的说明',
    required: false,
    ok: '派任务',
    done: '已派换号任务，充值员完成后工单自动标记已解决',
  },
  resolve: {
    title: '标记已解决',
    label: '处理结果',
    required: true,
    ok: '标记已解决',
    done: '已标记解决',
  },
  close: { title: '关闭工单', label: '备注', required: false, ok: '关闭', done: '工单已关闭' },
  reopen: {
    title: '重新打开工单',
    label: '原因',
    required: true,
    ok: '重新打开',
    done: '已重新打开',
  },
};

function TextActionModal({
  ticket,
  action,
  onClose,
}: {
  ticket: Ticket;
  action: TextAction;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const refresh = useAftersalesRefresh();
  const [form] = Form.useForm<{ text?: string }>();
  const meta = ACTION_META[action];
  const path = { params: { path: { id: ticket.id } } };
  const submit = useMutation({
    mutationFn: (text: string) => {
      switch (action) {
        case 'replace':
          return unwrap(
            api.POST('/api/tickets/{id}/replace', { ...path, body: { note: text || undefined } }),
          );
        case 'resolve':
          return unwrap(
            api.POST('/api/tickets/{id}/resolve', { ...path, body: { resolution: text } }),
          );
        case 'close':
          return unwrap(
            api.POST('/api/tickets/{id}/close', { ...path, body: { note: text || undefined } }),
          );
        case 'reopen':
          return unwrap(api.POST('/api/tickets/{id}/reopen', { ...path, body: { reason: text } }));
      }
    },
    onSuccess: () => {
      message.success(meta.done);
      refresh();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`${meta.title}：${ticket.code}`}
      okText={meta.ok}
      confirmLoading={submit.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      {action === 'replace' && (
        <Alert
          type={ticket.warranty.canReplace ? 'info' : 'warning'}
          showIcon
          style={{ marginBottom: 16 }}
          message={
            ticket.warranty.canReplace
              ? '在质保内，可以包换。服务期不变，换号的成本记到这笔订单上。'
              : `${ticket.warranty.summary}。确认要换的话，成本由公司承担。`
          }
        />
      )}
      <Form form={form} layout="vertical" onFinish={(v) => submit.mutate(v.text?.trim() ?? '')}>
        <Form.Item
          name="text"
          label={meta.label}
          rules={
            meta.required
              ? [{ required: true, whitespace: true, message: `请填写${meta.label}` }]
              : []
          }
        >
          <Input.TextArea rows={3} maxLength={500} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function CompensateModal({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) {
  const { message } = App.useApp();
  const refresh = useAftersalesRefresh();
  const [form] = Form.useForm<{ days: number; note?: string }>();
  const submit = useMutation({
    mutationFn: (v: { days: number; note?: string }) =>
      unwrap(
        api.POST('/api/tickets/{id}/compensate', {
          params: { path: { id: ticket.id } },
          body: { days: v.days, note: v.note?.trim() || undefined },
        }),
      ),
    onSuccess: (_, v) => {
      message.success(`已补偿 ${v.days} 天`);
      refresh();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`补偿服务天数：${ticket.subscription?.code ?? ''}`}
      okText="补偿"
      confirmLoading={submit.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Typography.Paragraph type="secondary">
        订阅的到期时间往后延，现在服务到 {formatTime(ticket.subscription?.endAt ?? null)}
        。如果因此覆盖了下一次上游扣费，系统会改派内部续费任务。
      </Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ days: 1 }}
        onFinish={(v) => submit.mutate(v)}
      >
        <Form.Item name="days" label="补偿天数" rules={[{ required: true, message: '请填写天数' }]}>
          <InputNumber min={1} max={90} precision={0} suffix="天" style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="note" label="原因">
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
