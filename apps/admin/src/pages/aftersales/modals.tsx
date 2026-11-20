import { useState } from 'react';
import { App, Checkbox, Form, Input, InputNumber, Modal, Select, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { TICKET_TYPES, TICKET_TYPE_LABELS, formatCents, type TicketType } from '@crm/shared';
import { api, unwrap } from '../../api/client';
import { CustomerSelect } from '../../components/business';

/** 工单、退款相关的数据变了以后要刷新的列表 */
export function useAftersalesRefresh() {
  const queryClient = useQueryClient();
  return () => {
    for (const key of [
      'tickets',
      'ticket',
      'refunds',
      'order',
      'orders',
      'subscription',
      'dashboard',
    ]) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
}

interface NewTicketForm {
  customerId: string;
  subscriptionId?: string;
  type: TicketType;
  description: string;
}

/** 登记售后工单。从订阅详情打开时客户和订阅已经选好 */
export function NewTicketModal({
  customer,
  subscriptionId,
  onClose,
  onCreated,
}: {
  customer?: { id: string; label: string };
  subscriptionId?: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { message } = App.useApp();
  const refresh = useAftersalesRefresh();
  const [form] = Form.useForm<NewTicketForm>();
  const [customerId, setCustomerId] = useState<string | undefined>(customer?.id);
  const subs = useQuery({
    queryKey: ['subscriptions', { customerId, pageSize: 50 }],
    queryFn: () =>
      unwrap(api.GET('/api/subscriptions', { params: { query: { customerId, pageSize: 50 } } })),
    enabled: !!customerId,
  });
  const create = useMutation({
    mutationFn: (v: NewTicketForm) =>
      unwrap(
        api.POST('/api/tickets', {
          body: {
            customerId: v.customerId,
            subscriptionId: v.subscriptionId || undefined,
            type: v.type,
            description: v.description.trim(),
          },
        }),
      ),
    onSuccess: (t) => {
      message.success(
        `已登记 ${t.code}${t.assignee ? `，指派给${t.assignee.displayName}` : '，等待售后领取'}`,
      );
      refresh();
      onCreated(t.id);
      onClose();
    },
  });
  return (
    <Modal
      open
      title="登记售后工单"
      okText="登记"
      confirmLoading={create.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Form<NewTicketForm>
        form={form}
        layout="vertical"
        initialValues={{ customerId: customer?.id, subscriptionId, type: 'BANNED' }}
        onFinish={(v) => create.mutate(v)}
      >
        <Form.Item
          name="customerId"
          label="客户"
          rules={[{ required: true, message: '请选择客户' }]}
        >
          <CustomerSelect
            initialOption={customer ? { value: customer.id, label: customer.label } : undefined}
            onChange={(id) => {
              setCustomerId(id);
              form.setFieldValue('subscriptionId', undefined);
            }}
          />
        </Form.Item>
        <Form.Item
          name="subscriptionId"
          label="出问题的订阅"
          extra="换号、补偿天数、按质保退款都要选订阅；咨询类问题可以不选"
        >
          <Select
            allowClear
            disabled={!customerId}
            loading={subs.isLoading}
            placeholder={customerId ? '选择订阅' : '先选客户'}
            options={(subs.data?.items ?? []).map((s) => ({
              value: s.id,
              label: `${s.code} ${s.planName} · ${s.account.email}${s.status === 'ACTIVE' ? '' : '（已不在服务中）'}`,
            }))}
          />
        </Form.Item>
        <Form.Item name="type" label="问题类型">
          <Select options={TICKET_TYPES.map((t) => ({ value: t, label: TICKET_TYPE_LABELS[t] }))} />
        </Form.Item>
        <Form.Item
          name="description"
          label="问题描述"
          rules={[{ required: true, whitespace: true, message: '请描述问题' }]}
        >
          <Input.TextArea rows={3} maxLength={1000} placeholder="客户反馈了什么、什么时候开始的" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

interface RefundForm {
  amount: number;
  reason: string;
  terminate?: boolean;
}

/** 申请退款：金额默认按质保折算，财务审批后出账 */
export function RefundRequestModal({
  order,
  ticketId,
  refundableCents,
  suggestedCents,
  onClose,
}: {
  order: { id: string; code: string };
  ticketId?: string;
  refundableCents: number;
  suggestedCents?: number;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const refresh = useAftersalesRefresh();
  const [form] = Form.useForm<RefundForm>();
  const initial = Math.min(suggestedCents ?? refundableCents, refundableCents);
  const request = useMutation({
    mutationFn: (v: RefundForm) =>
      unwrap(
        api.POST('/api/refunds', {
          body: {
            orderId: order.id,
            ticketId,
            amountCents: Math.round(v.amount * 100),
            reason: v.reason.trim(),
            terminate: v.terminate || undefined,
          },
        }),
      ),
    onSuccess: (r) => {
      message.success(`已提交退款申请 ${r.code}，等财务审批`);
      refresh();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`申请退款：订单 ${order.code}`}
      okText="提交审批"
      confirmLoading={request.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Typography.Paragraph type="secondary">
        这笔订单最多还能退 {formatCents(refundableCents)}
        {suggestedCents !== undefined &&
          `；按质保折算可退 ${formatCents(suggestedCents)}（质保费不退）`}
        。
      </Typography.Paragraph>
      <Form<RefundForm>
        form={form}
        layout="vertical"
        initialValues={{ amount: initial / 100 }}
        onFinish={(v) => request.mutate(v)}
      >
        <Form.Item
          name="amount"
          label="退款金额（元）"
          rules={[{ required: true, message: '请输入金额' }]}
        >
          <InputNumber
            min={0.01}
            max={refundableCents / 100}
            precision={2}
            prefix="¥"
            style={{ width: '100%' }}
          />
        </Form.Item>
        <Form.Item
          name="reason"
          label="退款原因"
          rules={[{ required: true, whitespace: true, message: '请填写退款原因' }]}
        >
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
        <Form.Item
          name="terminate"
          valuePropName="checked"
          extra="审批通过后：已开通的订阅终止，代充派「取消自动续订」任务、成品号派「回收」任务；还没开通的直接取消开通"
        >
          <Checkbox>退款后终止服务</Checkbox>
        </Form.Item>
      </Form>
    </Modal>
  );
}
