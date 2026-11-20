import { useState } from 'react';
import { Link } from 'react-router';
import { App, Button, Descriptions, Select, Tag, Tooltip, Typography } from 'antd';
import { EyeOutlined } from '@ant-design/icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ACCOUNT_STOCK_STATUS_LABELS,
  FULFILLMENT_TYPE_LABELS,
  ORDER_KIND_LABELS,
  ORDER_STATUS_LABELS,
  SUBSCRIPTION_STATUS_LABELS,
  TASK_STATUS_LABELS,
  TASK_TYPE_LABELS,
  formatCents,
  type AccountStockStatus,
  type FulfillmentType,
  type OrderKind,
  type OrderStatus,
  type SubscriptionStatus,
  type TaskStatus,
  type TaskType,
} from '@crm/shared';
import { api, unwrap, type Schemas } from '../api/client';
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
}: {
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
