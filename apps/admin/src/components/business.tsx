import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import { Alert, App, Button, Descriptions, Select, Tag, Tooltip, Typography } from 'antd';
import { EyeOutlined } from '@ant-design/icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import {
  ACCOUNT_STOCK_STATUS_LABELS,
  AGENT_STATUS_LABELS,
  COMMISSION_STATUS_LABELS,
  CUSTOMER_STAGE_HINTS,
  CUSTOMER_STAGE_LABELS,
  FULFILLMENT_TYPE_LABELS,
  ORDER_KIND_LABELS,
  ORDER_STATUS_LABELS,
  REFUND_STATUS_LABELS,
  STATEMENT_STATUS_LABELS,
  SUBSCRIPTION_STATUS_LABELS,
  TASK_STATUS_LABELS,
  TASK_TYPE_LABELS,
  TICKET_STATUS_LABELS,
  TICKET_TYPE_LABELS,
  channelPlatformLabel,
  formatCents,
  type AccountStockStatus,
  type AgentStatus,
  type CommissionStatus,
  type CustomerStage,
  type FulfillmentType,
  type OrderKind,
  type OrderStatus,
  type RefundStatus,
  type StatementStatus,
  type SubscriptionStatus,
  type TaskStatus,
  type TaskType,
  type TicketStatus,
  type TicketType,
} from '@crm/shared';
import { api, unwrap, type Schemas } from '../api/client';
import { useAgentOptions, useChannels } from '../api/queries';
import { useAuth } from '../auth/AuthProvider';

/** 业务页面共用的小组件：状态标签、金额、客户链接、查看密码等 */

export function Money({ cents, strong }: { cents: number; strong?: boolean }) {
  return (
    <Typography.Text strong={strong} style={{ whiteSpace: 'nowrap' }}>
      {formatCents(cents)}
    </Typography.Text>
  );
}

/** 美元金额（美分），例如 $101.50 */
export function Usd({
  cents,
  strong,
  type,
}: {
  cents: number;
  strong?: boolean;
  type?: 'danger' | 'secondary';
}) {
  return (
    <Typography.Text strong={strong} type={type} style={{ whiteSpace: 'nowrap' }}>
      {formatCents(cents, '$')}
    </Typography.Text>
  );
}

/** 毛利：负数标红 */
export function Margin({ cents, strong }: { cents: number; strong?: boolean }) {
  return (
    <Typography.Text
      strong={strong}
      type={cents < 0 ? 'danger' : undefined}
      style={{ whiteSpace: 'nowrap' }}
    >
      {formatCents(cents)}
    </Typography.Text>
  );
}

const STOCK_STATUS_COLORS: Record<AccountStockStatus, string> = {
  IN_STOCK: 'green',
  IN_USE: 'blue',
  VOID: 'default',
};
export function StockStatusTag({ status }: { status: AccountStockStatus }) {
  return <Tag color={STOCK_STATUS_COLORS[status]}>{ACCOUNT_STOCK_STATUS_LABELS[status]}</Tag>;
}

const ORDER_STATUS_COLORS: Record<OrderStatus, string> = {
  PENDING_PAYMENT: 'orange',
  FULFILLING: 'processing',
  COMPLETED: 'success',
  CANCELLED: 'default',
};
export function OrderStatusTag({ status }: { status: OrderStatus }) {
  return <Tag color={ORDER_STATUS_COLORS[status]}>{ORDER_STATUS_LABELS[status]}</Tag>;
}

export function OrderKindTag({ kind }: { kind: OrderKind }) {
  return <Tag color={kind === 'NEW' ? 'blue' : 'purple'}>{ORDER_KIND_LABELS[kind]}</Tag>;
}

export function FulfillmentTag({ type }: { type: FulfillmentType }) {
  return <Tag color={type === 'RECHARGE' ? 'cyan' : 'gold'}>{FULFILLMENT_TYPE_LABELS[type]}</Tag>;
}

const TASK_TYPE_COLORS: Record<TaskType, string> = {
  ACTIVATE: 'blue',
  RENEW: 'purple',
  INTERNAL_RENEW: 'cyan',
  CANCEL_AUTO_RENEW: 'volcano',
  RECLAIM_ACCOUNT: 'magenta',
  REPLACE_ACCOUNT: 'orange',
};
export function TaskTypeTag({ type }: { type: TaskType }) {
  return <Tag color={TASK_TYPE_COLORS[type]}>{TASK_TYPE_LABELS[type]}</Tag>;
}

const TASK_STATUS_COLORS: Record<TaskStatus, string> = {
  PENDING: 'default',
  IN_PROGRESS: 'processing',
  DONE: 'success',
  FAILED: 'error',
  CANCELLED: 'default',
};
export function TaskStatusTag({ status }: { status: TaskStatus }) {
  return <Tag color={TASK_STATUS_COLORS[status]}>{TASK_STATUS_LABELS[status]}</Tag>;
}

const SUB_STATUS_COLORS: Record<SubscriptionStatus, string> = {
  ACTIVE: 'success',
  EXPIRED: 'warning',
  CANCELLED: 'default',
};
export function SubscriptionStatusTag({ status }: { status: SubscriptionStatus }) {
  return <Tag color={SUB_STATUS_COLORS[status]}>{SUBSCRIPTION_STATUS_LABELS[status]}</Tag>;
}

const STAGE_COLORS: Record<CustomerStage, string> = {
  LEAD: 'default',
  NEW: 'cyan',
  ACTIVE: 'green',
  DORMANT: 'orange',
  CHURNED: 'red',
};
export function CustomerStageTag({ stage, vip }: { stage: CustomerStage; vip?: boolean }) {
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      <Tooltip title={CUSTOMER_STAGE_HINTS[stage]}>
        <Tag color={STAGE_COLORS[stage]}>{CUSTOMER_STAGE_LABELS[stage]}</Tag>
      </Tooltip>
      {vip && <Tag color="gold">VIP</Tag>}
    </span>
  );
}

const TICKET_TYPE_COLORS: Record<TicketType, string> = {
  NOT_EFFECTIVE: 'orange',
  BANNED: 'red',
  LIMITED: 'volcano',
  REFUND: 'purple',
  REPLACE: 'gold',
  OTHER: 'default',
};
export function TicketTypeTag({ type }: { type: TicketType }) {
  return <Tag color={TICKET_TYPE_COLORS[type]}>{TICKET_TYPE_LABELS[type]}</Tag>;
}

const TICKET_STATUS_COLORS: Record<TicketStatus, string> = {
  OPEN: 'orange',
  IN_PROGRESS: 'processing',
  WAITING_CUSTOMER: 'warning',
  RESOLVED: 'success',
  CLOSED: 'default',
};
export function TicketStatusTag({ status }: { status: TicketStatus }) {
  return <Tag color={TICKET_STATUS_COLORS[status]}>{TICKET_STATUS_LABELS[status]}</Tag>;
}

const REFUND_STATUS_COLORS: Record<RefundStatus, string> = {
  PENDING: 'orange',
  PAID: 'success',
  REJECTED: 'default',
};
export function RefundStatusTag({ status }: { status: RefundStatus }) {
  return <Tag color={REFUND_STATUS_COLORS[status]}>{REFUND_STATUS_LABELS[status]}</Tag>;
}

/** 质保结论：可包换 / 可退多少 / 不在质保内（原因） */
export function WarrantyAlert({
  warranty,
  title = '质保',
}: {
  warranty: Schemas['WarrantyDto'];
  title?: string;
}) {
  const period =
    warranty.periodStartAt && warranty.periodEndAt
      ? `服务期 ${dayjs(warranty.periodStartAt).format('YYYY-MM-DD')} 至 ${dayjs(warranty.periodEndAt).format('YYYY-MM-DD')}`
      : null;
  const detail = [
    warranty.order ? `按订单 ${warranty.order.code} 计算` : null,
    period,
    warranty.withWarranty ? `质保费 ${formatCents(warranty.warrantyCents)}（不退）` : null,
    warranty.covered
      ? `套餐实付 ${formatCents(warranty.planPaidCents)} × 剩余 ${warranty.remainingDays} 天 ÷ ${warranty.totalDays} 天`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Alert
      type={warranty.covered ? 'success' : 'warning'}
      showIcon
      message={`${title}：${warranty.summary}`}
      description={detail || undefined}
    />
  );
}

/** 剩余天数：7 天内橙色，3 天内红色，已到期灰色 */
export function DaysLeft({ days, status }: { days: number; status: SubscriptionStatus }) {
  if (status === 'CANCELLED') return <Typography.Text type="secondary">—</Typography.Text>;
  if (days <= 0) {
    return <Tag color="default">{days === 0 ? '今天到期' : `已到期 ${-days} 天`}</Tag>;
  }
  const color = days <= 3 ? 'red' : days <= 7 ? 'orange' : 'green';
  return <Tag color={color}>剩 {days} 天</Tag>;
}

export function CustomerLink({ customer }: { customer: Schemas['CustomerBriefDto'] }) {
  const { can } = useAuth();
  const contact = customer.wechat
    ? `微信 ${customer.wechat}`
    : customer.telegram
      ? `TG ${customer.telegram}`
      : '';
  const text = (
    <>
      {customer.name}
      <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}>
        {customer.code}
      </Typography.Text>
    </>
  );
  return (
    <Tooltip title={contact || undefined}>
      {can('customer:read') ? (
        <Link to={`/customers/${customer.id}`}>{text}</Link>
      ) : (
        <span>{text}</span>
      )}
    </Tooltip>
  );
}

/** 查看账号密码：需要权限，每次查看后端都会记操作日志 */
export function AccountSecretButton({
  account,
}: {
  account: Pick<Schemas['AccountBriefDto'], 'id' | 'email' | 'hasPassword' | 'hasSecretNote'>;
}) {
  const { can } = useAuth();
  const { modal } = App.useApp();
  const reveal = useMutation({
    mutationFn: () =>
      unwrap(api.GET('/api/accounts/{id}/secret', { params: { path: { id: account.id } } })),
    onSuccess: (s) =>
      modal.info({
        title: `账号信息：${s.email}`,
        width: 480,
        content: (
          <Descriptions column={1} size="small" style={{ marginTop: 12 }}>
            <Descriptions.Item label="密码">
              {s.password ? <Typography.Text copyable>{s.password}</Typography.Text> : '未录入'}
            </Descriptions.Item>
            <Descriptions.Item label="其他信息">
              {s.secretNote ? (
                <Typography.Text copyable style={{ whiteSpace: 'pre-wrap' }}>
                  {s.secretNote}
                </Typography.Text>
              ) : (
                '未录入'
              )}
            </Descriptions.Item>
          </Descriptions>
        ),
      }),
  });
  if (!can('account:secret:view') || (!account.hasPassword && !account.hasSecretNote)) return null;
  return (
    <Tooltip title="查看密码（会记录操作日志）">
      <Button
        type="link"
        size="small"
        icon={<EyeOutlined />}
        loading={reveal.isPending}
        onClick={() => reveal.mutate()}
      />
    </Tooltip>
  );
}

/** 搜索客户的下拉框（按当前员工的数据范围） */
export function CustomerSelect({
  value,
  onChange,
  initialOption,
  placeholder = '输入客户编号、称呼或微信搜索',
  id,
}: {
  id?: string;
  value?: string;
  onChange?: (id: string | undefined) => void;
  initialOption?: { value: string; label: string };
  placeholder?: string;
}) {
  const [keyword, setKeyword] = useState('');
  const customers = useQuery({
    queryKey: ['customers', 'select', keyword],
    queryFn: () =>
      unwrap(
        api.GET('/api/customers', {
          params: { query: { keyword: keyword || undefined, pageSize: 20 } },
        }),
      ),
  });
  const options = (customers.data?.items ?? []).map((c) => ({
    value: c.id,
    label: `${c.name}（${c.code}${c.wechat ? ` · ${c.wechat}` : ''}）`,
  }));
  if (initialOption && !options.some((o) => o.value === initialOption.value)) {
    options.unshift(initialOption);
  }
  return (
    <Select
      id={id}
      showSearch
      allowClear
      value={value}
      placeholder={placeholder}
      filterOption={false}
      onSearch={setKeyword}
      onChange={(v?: string) => onChange?.(v)}
      loading={customers.isFetching}
      options={options}
      notFoundContent={customers.isFetching ? '搜索中…' : '没有找到客户'}
    />
  );
}

/** 能看代理和佣金的权限：任意一个即可（和后端 AGENT_VIEW_PERMISSIONS 一致） */
export const AGENT_VIEW_PERMISSIONS = ['agent:read', 'agent:write', 'commission:settle'];

export function AgentStatusTag({ status }: { status: AgentStatus }) {
  return <Tag color={status === 'ACTIVE' ? 'green' : 'default'}>{AGENT_STATUS_LABELS[status]}</Tag>;
}

/** 代理名称 + 编号；有代理查看权限时可以点进详情 */
export function AgentLink({ agent }: { agent: Schemas['AgentBriefDto'] }) {
  const { can } = useAuth();
  const text = (
    <>
      {agent.name}
      <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}>
        {agent.code}
      </Typography.Text>
    </>
  );
  return AGENT_VIEW_PERMISSIONS.some((p) => can(p)) ? (
    <Link to={`/agents/${agent.id}`}>{text}</Link>
  ) : (
    <span>{text}</span>
  );
}

/** 选择代理的下拉框；停用的代理不能选。topLevelOnly 只列一级代理（设置上级时用） */
export function AgentSelect({
  value,
  onChange,
  placeholder = '搜索代理名称或编号',
  topLevelOnly,
  excludeId,
  allowClear = true,
  allowDisabled,
  disabled,
  style,
  id,
}: {
  value?: string | null;
  onChange?: (id: string | null) => void;
  placeholder?: string;
  topLevelOnly?: boolean;
  excludeId?: string;
  allowClear?: boolean;
  /** 筛选时用：停用的代理也能选 */
  allowDisabled?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
  /** Form.Item 传进来的 id，让标签能点到下拉框 */
  id?: string;
}) {
  const agents = useAgentOptions();
  const options = (agents.data ?? [])
    .filter((a) => (!topLevelOnly || a.parentName === null) && a.id !== excludeId)
    .map((a) => ({
      value: a.id,
      label: `${a.name}（${a.code}${a.parentName ? ` · 上级 ${a.parentName}` : ''}）${
        a.status === 'ACTIVE' ? '' : ' · 已停用'
      }`,
      disabled: !allowDisabled && a.status !== 'ACTIVE' && a.id !== value,
    }));
  return (
    <Select
      id={id}
      showSearch
      allowClear={allowClear}
      value={value ?? undefined}
      placeholder={placeholder}
      optionFilterProp="label"
      loading={agents.isLoading}
      options={options}
      disabled={disabled}
      style={style}
      onChange={(v?: string) => onChange?.(v ?? null)}
      notFoundContent={agents.isLoading ? '加载中…' : '没有代理，先在「代理」页新增'}
    />
  );
}

/** 选渠道：停用的渠道不能新选，已经选了的照样显示 */
export function ChannelSelect({
  value,
  onChange,
  placeholder = '客户从哪个渠道来的',
  allowDisabled,
  withNone,
  style,
  id,
}: {
  value?: string | null;
  onChange?: (id: string | null) => void;
  placeholder?: string;
  /** 筛选时用：停用的渠道也能选 */
  allowDisabled?: boolean;
  /** 筛选时用：加一项「未标渠道」 */
  withNone?: boolean;
  style?: CSSProperties;
  id?: string;
}) {
  const channels = useChannels();
  const options = [
    ...(withNone ? [{ value: 'none', label: '未标渠道', disabled: false }] : []),
    ...(channels.data ?? []).map((c) => ({
      value: c.id,
      label: `${c.name} · ${channelPlatformLabel(c.platform)}${c.enabled ? '' : ' · 已停用'}`,
      disabled: !allowDisabled && !c.enabled && c.id !== value,
    })),
  ];
  return (
    <Select
      id={id}
      showSearch
      allowClear
      value={value ?? undefined}
      placeholder={placeholder}
      optionFilterProp="label"
      loading={channels.isLoading}
      options={options}
      style={style}
      onChange={(v?: string) => onChange?.(v ?? null)}
      notFoundContent={channels.isLoading ? '加载中…' : '还没有渠道，在「渠道与营销」里新增'}
    />
  );
}

const COMMISSION_STATUS_COLORS: Record<CommissionStatus, string> = {
  FROZEN: 'blue',
  RELEASABLE: 'green',
  SETTLED: 'purple',
  PAID: 'default',
  VOID: 'default',
};
export function CommissionStatusTag({ status }: { status: CommissionStatus }) {
  return (
    <Tag color={COMMISSION_STATUS_COLORS[status]} style={status === 'VOID' ? { opacity: 0.6 } : {}}>
      {COMMISSION_STATUS_LABELS[status]}
    </Tag>
  );
}

const STATEMENT_STATUS_COLORS: Record<StatementStatus, string> = {
  DRAFT: 'orange',
  CONFIRMED: 'blue',
  PAID: 'green',
  CANCELLED: 'default',
};
export function StatementStatusTag({ status }: { status: StatementStatus }) {
  return <Tag color={STATEMENT_STATUS_COLORS[status]}>{STATEMENT_STATUS_LABELS[status]}</Tag>;
}

/** 对账单应付金额：正数是我们打给代理，负数是代理要补交 */
export function PayableText({ cents, strong }: { cents: number; strong?: boolean }) {
  if (cents < 0) {
    return (
      <Typography.Text strong={strong} type="danger" style={{ whiteSpace: 'nowrap' }}>
        代理补交 {formatCents(-cents)}
      </Typography.Text>
    );
  }
  return (
    <Typography.Text strong={strong} style={{ whiteSpace: 'nowrap' }}>
      {formatCents(cents)}
    </Typography.Text>
  );
}
