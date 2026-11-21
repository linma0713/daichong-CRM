import { App, Form, Input, Modal, Select, Space, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LOST_REASONS, type LostReason, type ScriptCategory, type ScriptVars } from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { ScriptPicker } from '../../components/scripts';

type CustomerLike = Pick<Schemas['CustomerDto'], 'id' | 'name' | 'code' | 'owner'>;

/** 话术变量：客户层面能填的（没有具体订阅时） */
export function customerVars(c: CustomerLike): ScriptVars {
  return { 客户称呼: c.name, 客服: c.owner.displayName };
}

function useCustomerInvalidate() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['customers'] });
    void queryClient.invalidateQueries({ queryKey: ['customer'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };
}

/** 记录一次召回（写进跟进记录，客户就从「没联系过」里移出） */
export function RecallModal({
  customer,
  scriptCategory = 'recall',
  scriptVars,
  onClose,
}: {
  customer: CustomerLike;
  scriptCategory?: ScriptCategory;
  scriptVars?: ScriptVars;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const invalidate = useCustomerInvalidate();
  const [form] = Form.useForm<{ content: string }>();
  const save = useMutation({
    mutationFn: (content: string) =>
      unwrap(
        api.POST('/api/customers/{id}/follow-ups', {
          params: { path: { id: customer.id } },
          body: { content, kind: 'recall' },
        }),
      ),
    onSuccess: () => {
      message.success('已记录');
      invalidate();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`记录召回：${customer.name}`}
      okText="保存"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Space style={{ marginBottom: 8 }}>
        <Typography.Text type="secondary">先发消息给客户：</Typography.Text>
        <ScriptPicker
          category={scriptCategory}
          vars={scriptVars ?? customerVars(customer)}
          type="default"
          text="选话术并复制"
        />
      </Space>
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v.content.trim())}>
        <Form.Item
          name="content"
          label="沟通情况"
          rules={[{ required: true, whitespace: true, message: '请填写沟通情况' }]}
        >
          <Input.TextArea
            rows={3}
            maxLength={1000}
            placeholder="例如：微信发了回访话术，客户说下个月项目开始再续"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

/** 记录流失原因。客户以后再付款会自动清掉 */
export function LostReasonModal({
  customer,
  onClose,
}: {
  customer: CustomerLike & Pick<Schemas['CustomerDto'], 'lostReason' | 'lostNote'>;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const invalidate = useCustomerInvalidate();
  const [form] = Form.useForm<{ reason: LostReason; note?: string }>();
  const save = useMutation({
    mutationFn: (v: { reason: LostReason; note?: string }) =>
      unwrap(
        api.POST('/api/customers/{id}/lost-reason', {
          params: { path: { id: customer.id } },
          body: v,
        }),
      ),
    onSuccess: () => {
      message.success('已记录');
      invalidate();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`记录流失原因：${customer.name}`}
      okText="保存"
      confirmLoading={save.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      <Typography.Paragraph type="secondary">
        客户明确不续了再记。数据看板会统计流失原因，帮你看是价格、体验还是竞争的问题；客户以后回来付款会自动清掉。
      </Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          reason: (customer.lostReason as LostReason | null) ?? undefined,
          note: customer.lostNote ?? undefined,
        }}
        onFinish={(v) => save.mutate({ reason: v.reason, note: v.note?.trim() || undefined })}
      >
        <Form.Item
          name="reason"
          label="原因"
          rules={[{ required: true, message: '请选择流失原因' }]}
        >
          <Select options={LOST_REASONS.map((r) => ({ value: r.value, label: r.label }))} />
        </Form.Item>
        <Form.Item name="note" label="补充说明">
          <Input.TextArea rows={2} maxLength={500} placeholder="例如：说官方涨价后觉得不划算" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
