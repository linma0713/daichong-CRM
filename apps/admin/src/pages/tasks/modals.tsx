import { useState } from 'react';
import {
  Alert,
  App,
  Checkbox,
  DatePicker,
  Divider,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Space,
  Typography,
} from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import { TASK_TYPE_LABELS, formatCents, type TaskType } from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { useResources, useStaffOptions } from '../../api/queries';

type Task = Schemas['TaskDto'];

/** 每类任务要做什么，显示在完成弹窗和手机端任务详情里 */
export const TASK_GUIDE: Record<TaskType, string> = {
  ACTIVATE: '为客户开通订阅',
  RENEW: '客户已付款续费：为这个订阅续上服务（上游如已停止自动续订，需要重新订阅）',
  INTERNAL_RENEW: '客户买的是季付 / 年付，上游按月扣费：确认这次上游扣费成功（付款资源余额充足）',
  CANCEL_AUTO_RENEW:
    '客户付费的服务期快结束且还没续费：在上游下次扣费前取消自动续订，避免替客户垫付',
  RECLAIM_ACCOUNT: '成品号到期未续费：收回账号（建议修改密码），之后可以再卖给其他客户',
  REPLACE_ACCOUNT:
    '售后换号：给客户换一个能用的账号，服务期不变。成品号从库存选新号；代充换成客户提供的新账号，一般要重新付费',
};

interface CompleteForm {
  note?: string;
  activatedAt?: Dayjs;
  upstreamRenewAt?: Dayjs;
  stockAccountId?: string;
  accountEmail?: string;
  accountPassword?: string;
  accountSecretNote?: string;
  resourceId?: string;
  chargeUsd?: number;
  noCharge?: boolean;
  reclaimTo?: 'STOCK' | 'VOID';
}

export function CompleteModal({
  task,
  onClose,
  onDone,
}: {
  task: Task;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [form] = Form.useForm<CompleteForm>();
  const isActivate = task.type === 'ACTIVATE';
  const isReplace = task.type === 'REPLACE_ACCOUNT';
  const deliversAccount = (isActivate || isReplace) && task.fulfillmentType === 'ACCOUNT';
  const newCustomerAccount = isReplace && task.fulfillmentType === 'RECHARGE';
  const movesOldAccount =
    task.type === 'RECLAIM_ACCOUNT' || (isReplace && task.fulfillmentType === 'ACCOUNT');
  const resources = useResources(task.chargeMode !== 'none');
  const activeResources = resources.data?.filter((r) => r.active) ?? [];
  const stock = useQuery({
    queryKey: ['stock-accounts', { planId: task.planId, status: 'IN_STOCK', pageSize: 100 }],
    queryFn: () =>
      unwrap(
        api.GET('/api/stock-accounts', {
          params: {
            query: { planId: task.planId ?? undefined, status: 'IN_STOCK', pageSize: 100 },
          },
        }),
      ),
    enabled: deliversAccount && !!task.planId,
  });
  const stockItems = stock.data?.items ?? [];
  const [source, setSource] = useState<'stock' | 'manual' | null>(null);
  const accountSource = source ?? (stockItems.length ? 'stock' : 'manual');
  const noCharge = Form.useWatch('noCharge', form);
  const stockAccountId = Form.useWatch('stockAccountId', form);
  const pickedStock = stockItems.find((a) => a.id === stockAccountId);
  // 选的库存号已经过了上游付费日，要重新付费
  const stockLapsed =
    !!pickedStock?.upstreamRenewAt && dayjs(pickedStock.upstreamRenewAt).isBefore(dayjs());
  const chargeRequired = task.chargeMode === 'required' || stockLapsed;
  const defaultUsd = task.upstreamMonthlyUsdCents ? task.upstreamMonthlyUsdCents / 100 : undefined;
  const askUpstream =
    isActivate || isReplace || task.type === 'RENEW' || task.type === 'INTERNAL_RENEW';
  const upstreamHint: Record<string, string> = {
    REPLACE_ACCOUNT: '不填：这次登记了扣费 = 现在 + 1 个月；从库存发的号沿用号上的付费日',
    ACTIVATE: '不填 = 开通时间 + 1 个月',
    RENEW: '不填 = 保持原来的扣费时间（之前取消过自动续订的，默认现在 + 1 个月）',
    INTERNAL_RENEW: `不填 = 原扣费时间 + 1 个月${
      task.subscription?.upstreamRenewAt
        ? `（${dayjs(task.subscription.upstreamRenewAt).add(1, 'month').format('YYYY-MM-DD HH:mm')}）`
        : ''
    }`,
  };

  const complete = useMutation({
    mutationFn: (v: CompleteForm) =>
      unwrap(
        api.POST('/api/tasks/{id}/complete', {
          params: { path: { id: task.id } },
          body: {
            note: v.note || undefined,
            activatedAt: v.activatedAt?.toISOString(),
            upstreamRenewAt: v.upstreamRenewAt?.toISOString(),
            stockAccountId:
              deliversAccount && accountSource === 'stock' ? v.stockAccountId : undefined,
            accountEmail:
              deliversAccount && accountSource === 'stock'
                ? undefined
                : v.accountEmail?.trim() || undefined,
            accountPassword: v.accountPassword || undefined,
            accountSecretNote: v.accountSecretNote || undefined,
            resourceId: v.noCharge ? undefined : v.resourceId,
            chargeUsdCents:
              v.noCharge || !v.resourceId || v.chargeUsd === undefined || v.chargeUsd === null
                ? undefined
                : Math.round(v.chargeUsd * 100),
            noCharge: v.noCharge || undefined,
            reclaimTo: movesOldAccount ? v.reclaimTo : undefined,
          },
        }),
      ),
    onSuccess: (t) => {
      message.success(
        t.type === 'ACTIVATE' && t.subscription
          ? `已完成，订阅 ${t.subscription.code} 开始计时`
          : t.type === 'REPLACE_ACCOUNT'
            ? `已换号，${t.ticket?.code ?? '工单'} 自动标记为已解决`
            : '已完成',
      );
      for (const key of ['resources', 'stock-accounts', 'inventory-summary', 'tickets']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      onDone();
      onClose();
    },
  });

  return (
    <Modal
      open
      title={`完成任务：${TASK_TYPE_LABELS[task.type]} · ${task.customer.name}`}
      okText="确认完成"
      confirmLoading={complete.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
      width={560}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={TASK_GUIDE[task.type]}
        description={
          task.order
            ? `${task.order.code} ${task.order.productName}${task.account ? ` · ${task.account.email}` : ''}`
            : task.subscription
              ? `${task.subscription.code} ${task.subscription.planName}${task.account ? ` · ${task.account.email}` : ''}`
              : undefined
        }
      />
      <Form<CompleteForm>
        form={form}
        layout="vertical"
        initialValues={{ chargeUsd: defaultUsd, reclaimTo: isReplace ? 'VOID' : 'STOCK' }}
        onFinish={(v) => complete.mutate(v)}
      >
        {deliversAccount && (
          <>
            <Form.Item label="交付哪个号">
              <Radio.Group
                value={accountSource}
                onChange={(e) => setSource(e.target.value as 'stock' | 'manual')}
                options={[
                  {
                    value: 'stock',
                    label: `从库存选（在库 ${stockItems.length} 个）`,
                    disabled: stockItems.length === 0,
                  },
                  { value: 'manual', label: '手动登记一个新号' },
                ]}
              />
            </Form.Item>
            {accountSource === 'stock' ? (
              <Form.Item
                name="stockAccountId"
                label="库存成品号"
                initialValue={stockItems[0]?.id}
                rules={[{ required: true, message: '请选择要交付的成品号' }]}
                extra={
                  stockLapsed
                    ? '这个号的上游付费已过期，交付前要重新订阅，并在下面登记这次扣费'
                    : '按入库时间先进先出；备号成本会结转到这笔订单'
                }
              >
                <Select
                  loading={stock.isLoading}
                  options={stockItems.map((a) => ({
                    value: a.id,
                    label: `${a.email}（付费到 ${a.upstreamRenewAt ? dayjs(a.upstreamRenewAt).format('MM-DD') : '未付费'}）`,
                  }))}
                />
              </Form.Item>
            ) : (
              <>
                <Form.Item
                  name="accountEmail"
                  label="交付的成品号邮箱"
                  rules={[
                    { required: true, message: '请填写交付的账号' },
                    { type: 'email', message: '邮箱格式不正确' },
                  ]}
                >
                  <Input autoComplete="off" />
                </Form.Item>
                <Form.Item
                  name="accountPassword"
                  label="登录密码"
                  extra="新账号必填；回收再卖的旧账号不填则沿用原密码。加密保存。"
                >
                  <Input.Password autoComplete="new-password" />
                </Form.Item>
              </>
            )}
            <Form.Item
              name="accountSecretNote"
              label="其他敏感信息"
              extra="恢复邮箱、备用码等，加密保存；不填则不改"
            >
              <Input.TextArea rows={2} maxLength={1000} />
            </Form.Item>
          </>
        )}
        {isReplace && task.ticket && (
          <Typography.Paragraph type="secondary" style={{ marginTop: -4 }}>
            售后 {task.ticket.code}：{task.ticket.description}
          </Typography.Paragraph>
        )}
        {newCustomerAccount && (
          <>
            <Form.Item
              name="accountEmail"
              label="客户新的 Claude 账号邮箱"
              rules={[
                { required: true, message: '请填写客户新的账号' },
                { type: 'email', message: '邮箱格式不正确' },
              ]}
              extra="原账号如果还绑着我们的付款资源，记得顺手解绑"
            >
              <Input autoComplete="off" />
            </Form.Item>
            <Form.Item name="accountPassword" label="新账号密码" extra="可不填；加密保存">
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          </>
        )}
        {isReplace && task.fulfillmentType === 'ACCOUNT' && (
          <Form.Item name="reclaimTo" label="原来的号">
            <Radio.Group
              options={[
                { value: 'VOID', label: '作废（封号 / 不能用了）' },
                { value: 'STOCK', label: '回库，之后再卖' },
              ]}
            />
          </Form.Item>
        )}
        {task.chargeMode !== 'none' && (
          <>
            <Divider orientation="left" plain style={{ marginTop: 0 }}>
              上游扣费
            </Divider>
            {!noCharge && (
              <Space.Compact block>
                <Form.Item
                  name="resourceId"
                  label="用哪个付款资源"
                  style={{ flex: 1, marginRight: 12 }}
                  rules={
                    chargeRequired && activeResources.length > 0
                      ? [{ required: true, message: '请选择付款资源，或勾选「本次未扣费」' }]
                      : []
                  }
                  extra={
                    activeResources.length === 0
                      ? '还没有配置付款资源，这次可以先不登记'
                      : chargeRequired
                        ? '会从余额里扣，并按平均成本记到订单'
                        : '从库存发号一般不用付费；号过期了要重新付才选'
                  }
                >
                  <Select
                    allowClear
                    loading={resources.isLoading}
                    options={activeResources.map((r) => ({
                      value: r.id,
                      label: `${r.name}（余额 ${formatCents(r.balanceUsdCents, '$')}）`,
                    }))}
                  />
                </Form.Item>
                <Form.Item
                  name="chargeUsd"
                  label="扣费（美元）"
                  style={{ width: 140 }}
                  extra="不含手续费"
                >
                  <InputNumber min={0.01} style={{ width: '100%' }} />
                </Form.Item>
              </Space.Compact>
            )}
            {chargeRequired && (
              <Form.Item name="noCharge" valuePropName="checked" style={{ marginTop: -8 }}>
                <Checkbox>本次未扣费（例如账号本来就在付费期内）</Checkbox>
              </Form.Item>
            )}
          </>
        )}
        {isActivate && (
          <Form.Item
            name="activatedAt"
            label="实际开通时间"
            extra="服务期从这里开始算；不填 = 现在"
          >
            <DatePicker
              showTime
              style={{ width: '100%' }}
              disabledDate={(d) => d.isAfter(dayjs())}
            />
          </Form.Item>
        )}
        {askUpstream && (
          <Form.Item
            name="upstreamRenewAt"
            label="上游下次扣费时间"
            extra={upstreamHint[task.type]}
          >
            <DatePicker showTime style={{ width: '100%' }} />
          </Form.Item>
        )}
        {task.type === 'RECLAIM_ACCOUNT' && (
          <>
            <Form.Item name="reclaimTo" label="收回后">
              <Radio.Group
                options={[
                  { value: 'STOCK', label: '回库，之后再卖' },
                  { value: 'VOID', label: '作废（号已不能用）' },
                ]}
              />
            </Form.Item>
            <Form.Item
              name="accountPassword"
              label="修改后的新密码"
              extra="建议收回后立即改密；不填则不变"
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          </>
        )}
        <Form.Item name="note" label="备注">
          <Input.TextArea rows={2} maxLength={500} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function NoteModal({
  task,
  action,
  onClose,
  onDone,
}: {
  task: Task;
  action: 'fail' | 'cancel';
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const [form] = Form.useForm<{ note: string }>();
  const submit = useMutation({
    mutationFn: (note: string) =>
      unwrap(
        action === 'fail'
          ? api.POST('/api/tasks/{id}/fail', { params: { path: { id: task.id } }, body: { note } })
          : api.POST('/api/tasks/{id}/cancel', {
              params: { path: { id: task.id } },
              body: { note },
            }),
      ),
    onSuccess: () => {
      message.success(action === 'fail' ? '已标记失败，处理好后可以重新开始' : '任务已作废');
      onDone();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`${action === 'fail' ? '标记失败' : '作废任务'}：${task.code}`}
      okText="确认"
      okButtonProps={{ danger: true }}
      confirmLoading={submit.isPending}
      onOk={() => form.submit()}
      onCancel={onClose}
    >
      {action === 'cancel' && (
        <Typography.Paragraph type="secondary">
          {task.type === 'CANCEL_AUTO_RENEW'
            ? '作废后不会取消自动续订，上游到期会继续扣费。只在客户确认马上续费时作废。'
            : '作废后账号继续留在客户手里。只在客户确认马上续费时作废。'}
        </Typography.Paragraph>
      )}
      <Form form={form} layout="vertical" onFinish={(v) => submit.mutate(v.note)}>
        <Form.Item name="note" label="原因" rules={[{ required: true, message: '请填写原因' }]}>
          <Input.TextArea rows={3} maxLength={500} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function AssignModal({
  task,
  onClose,
  onDone,
}: {
  task: Task;
  onClose: () => void;
  onDone: () => void;
}) {
  const { message } = App.useApp();
  const staff = useStaffOptions();
  const [assigneeId, setAssigneeId] = useState<string | null>(task.assignee?.id ?? null);
  const assign = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/tasks/{id}/assign', {
          params: { path: { id: task.id } },
          body: { assigneeId },
        }),
      ),
    onSuccess: () => {
      message.success(assigneeId ? '已转交' : '已放回任务池');
      onDone();
      onClose();
    },
  });
  return (
    <Modal
      open
      title={`转交任务：${task.code}`}
      okText="确认"
      confirmLoading={assign.isPending}
      onOk={() => assign.mutate()}
      onCancel={onClose}
    >
      <Select
        style={{ width: '100%' }}
        value={assigneeId ?? '__pool'}
        onChange={(v: string) => setAssigneeId(v === '__pool' ? null : v)}
        options={[
          { value: '__pool', label: '放回任务池（谁有空谁领）' },
          ...(staff.data ?? [])
            .filter((s) => s.canFulfill)
            .map((s) => ({ value: s.id, label: s.displayName })),
        ]}
      />
    </Modal>
  );
}
