/** 业务枚举和显示文案，前后端共用，保证各端叫法一致 */

export type FulfillmentType = 'RECHARGE' | 'ACCOUNT';
export const FULFILLMENT_TYPES: FulfillmentType[] = ['RECHARGE', 'ACCOUNT'];
export const FULFILLMENT_TYPE_LABELS: Record<FulfillmentType, string> = {
  RECHARGE: '代充',
  ACCOUNT: '成品号',
};

/** 服务时长的叫法：1 月付、3 季付、12 年付，其他显示为「N 个月」 */
export function termLabel(months: number): string {
  if (months === 1) return '月付';
  if (months === 3) return '季付';
  if (months === 6) return '半年付';
  if (months === 12) return '年付';
  return `${months} 个月`;
}

export const CUSTOMER_SOURCES = [
  { value: 'organic', label: '自然流量' },
  { value: 'referral', label: '老客推荐' },
  { value: 'agent', label: '代理' },
  { value: 'ads', label: '投放' },
  { value: 'other', label: '其他' },
] as const;
export type CustomerSource = (typeof CUSTOMER_SOURCES)[number]['value'];
export const CUSTOMER_SOURCE_VALUES = CUSTOMER_SOURCES.map((s) => s.value) as CustomerSource[];

export const PAYMENT_METHODS = [
  { value: 'wechat', label: '微信' },
  { value: 'alipay', label: '支付宝' },
  { value: 'usdt', label: 'USDT' },
  { value: 'bank', label: '银行转账' },
  { value: 'other', label: '其他' },
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]['value'];
export const PAYMENT_METHOD_VALUES = PAYMENT_METHODS.map((m) => m.value) as PaymentMethod[];

export type OrderKind = 'NEW' | 'RENEWAL';
export const ORDER_KIND_LABELS: Record<OrderKind, string> = { NEW: '新购', RENEWAL: '续费' };

export type OrderStatus = 'PENDING_PAYMENT' | 'FULFILLING' | 'COMPLETED' | 'CANCELLED';
export const ORDER_STATUSES: OrderStatus[] = [
  'PENDING_PAYMENT',
  'FULFILLING',
  'COMPLETED',
  'CANCELLED',
];
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  PENDING_PAYMENT: '待收款',
  FULFILLING: '开通中',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
};

export type TaskType =
  | 'ACTIVATE'
  | 'RENEW'
  | 'INTERNAL_RENEW'
  | 'CANCEL_AUTO_RENEW'
  | 'RECLAIM_ACCOUNT'
  | 'REPLACE_ACCOUNT';
export const TASK_TYPES: TaskType[] = [
  'ACTIVATE',
  'RENEW',
  'INTERNAL_RENEW',
  'CANCEL_AUTO_RENEW',
  'RECLAIM_ACCOUNT',
  'REPLACE_ACCOUNT',
];
export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  ACTIVATE: '新开通',
  RENEW: '客户续费',
  INTERNAL_RENEW: '内部续费',
  CANCEL_AUTO_RENEW: '取消自动续订',
  RECLAIM_ACCOUNT: '回收成品号',
  REPLACE_ACCOUNT: '售后换号',
};

export type TaskStatus = 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'FAILED' | 'CANCELLED';
export const TASK_STATUSES: TaskStatus[] = [
  'PENDING',
  'IN_PROGRESS',
  'DONE',
  'FAILED',
  'CANCELLED',
];
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  PENDING: '待处理',
  IN_PROGRESS: '处理中',
  DONE: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
};

export type SubscriptionStatus = 'ACTIVE' | 'EXPIRED' | 'CANCELLED';
export const SUBSCRIPTION_STATUSES: SubscriptionStatus[] = ['ACTIVE', 'EXPIRED', 'CANCELLED'];
export const SUBSCRIPTION_STATUS_LABELS: Record<SubscriptionStatus, string> = {
  ACTIVE: '服务中',
  EXPIRED: '已到期',
  CANCELLED: '已终止',
};

// ─── M2 库存与成本 ───

export type ResourceType = 'VIRTUAL_CARD' | 'GIFT_CARD' | 'BALANCE';
export const RESOURCE_TYPES: ResourceType[] = ['VIRTUAL_CARD', 'GIFT_CARD', 'BALANCE'];
export const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
  VIRTUAL_CARD: '虚拟卡',
  GIFT_CARD: '礼品卡',
  BALANCE: '账户余额',
};

export type ResourceTxType = 'TOP_UP' | 'CONSUME' | 'ADJUST';
export const RESOURCE_TX_TYPES: ResourceTxType[] = ['TOP_UP', 'CONSUME', 'ADJUST'];
export const RESOURCE_TX_TYPE_LABELS: Record<ResourceTxType, string> = {
  TOP_UP: '入库',
  CONSUME: '扣费',
  ADJUST: '盘点调整',
};

export type AccountStockStatus = 'IN_STOCK' | 'IN_USE' | 'VOID';
export const ACCOUNT_STOCK_STATUSES: AccountStockStatus[] = ['IN_STOCK', 'IN_USE', 'VOID'];
export const ACCOUNT_STOCK_STATUS_LABELS: Record<AccountStockStatus, string> = {
  IN_STOCK: '在库',
  IN_USE: '使用中',
  VOID: '已作废',
};

export type CostKind = 'UPSTREAM_CHARGE' | 'ACCOUNT_STOCK' | 'OTHER';
export const COST_KINDS: CostKind[] = ['UPSTREAM_CHARGE', 'ACCOUNT_STOCK', 'OTHER'];
export const COST_KIND_LABELS: Record<CostKind, string> = {
  UPSTREAM_CHARGE: '上游扣费',
  ACCOUNT_STOCK: '成品号成本',
  OTHER: '其他成本',
};

// ─── M2 售后与质保 ───

export type TicketType = 'NOT_EFFECTIVE' | 'BANNED' | 'LIMITED' | 'REFUND' | 'REPLACE' | 'OTHER';
export const TICKET_TYPES: TicketType[] = [
  'NOT_EFFECTIVE',
  'BANNED',
  'LIMITED',
  'REFUND',
  'REPLACE',
  'OTHER',
];
export const TICKET_TYPE_LABELS: Record<TicketType, string> = {
  NOT_EFFECTIVE: '未生效',
  BANNED: '封号',
  LIMITED: '限额',
  REFUND: '退款',
  REPLACE: '换号',
  OTHER: '其他',
};

export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'WAITING_CUSTOMER' | 'RESOLVED' | 'CLOSED';
export const TICKET_STATUSES: TicketStatus[] = [
  'OPEN',
  'IN_PROGRESS',
  'WAITING_CUSTOMER',
  'RESOLVED',
  'CLOSED',
];
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  OPEN: '待处理',
  IN_PROGRESS: '处理中',
  WAITING_CUSTOMER: '等客户回复',
  RESOLVED: '已解决',
  CLOSED: '已关闭',
};

/** 不在质保范围内的客户自身原因 */
export const CUSTOMER_FAULTS = [
  { value: 'VIOLATION', label: '客户违规使用' },
  { value: 'CHANGED_PASSWORD', label: '客户自行改密码' },
  { value: 'BOUND_CARD', label: '客户自行绑卡' },
  { value: 'OTHER', label: '其他客户原因' },
] as const;
export type CustomerFault = (typeof CUSTOMER_FAULTS)[number]['value'];
export const CUSTOMER_FAULT_VALUES = CUSTOMER_FAULTS.map((f) => f.value) as CustomerFault[];

export type RefundStatus = 'PENDING' | 'PAID' | 'REJECTED';
export const REFUND_STATUSES: RefundStatus[] = ['PENDING', 'PAID', 'REJECTED'];
export const REFUND_STATUS_LABELS: Record<RefundStatus, string> = {
  PENDING: '待审批',
  PAID: '已退款',
  REJECTED: '已驳回',
};

const DAY_MS = 24 * 3600 * 1000;

/**
 * 质保按天退款：退款 = 套餐实付 × 剩余天数 ÷ 服务总天数（质保费不退）。
 * 剩余天数按整天向下取整，当天不算；已经退过的钱要扣掉。
 */
export function proratedRefund(input: {
  planPaidCents: number;
  periodStartAt: Date;
  periodEndAt: Date;
  at: Date;
  refundedCents?: number;
}): { totalDays: number; remainingDays: number; amountCents: number } {
  const totalDays = Math.max(
    1,
    Math.round((input.periodEndAt.getTime() - input.periodStartAt.getTime()) / DAY_MS),
  );
  const remainingDays = Math.min(
    totalDays,
    Math.max(0, Math.floor((input.periodEndAt.getTime() - input.at.getTime()) / DAY_MS)),
  );
  const gross = Math.round((Math.max(0, input.planPaidCents) * remainingDays) / totalDays);
  return {
    totalDays,
    remainingDays,
    amountCents: Math.max(0, gross - (input.refundedCents ?? 0)),
  };
}

/** 按比例 + 固定金额计算手续费；比例用万分比（150 = 1.5%） */
export function feeOf(amount: number, bp: number, fixed = 0): number {
  if (amount <= 0) return 0;
  return Math.round((amount * bp) / 10000) + fixed;
}

/** 金额（分）显示为 ¥1,234.50 */
export function formatCents(cents: number, currency: '¥' | '$' = '¥'): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}${currency}${yuan}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * 编号显示：C00012（客户）、D00012（订单）、S00012（订阅）、T00012（任务）、
 * R00012（付款资源）、G00012（售后工单）、K00012（退款）
 */
export function displayNo(prefix: 'C' | 'D' | 'S' | 'T' | 'R' | 'G' | 'K', no: number): string {
  return `${prefix}${String(no).padStart(5, '0')}`;
}

/** 搜索框里输入 C12 / c00012 / 12 都能找到编号 12 */
export function parseNo(keyword: string | undefined, prefix: string): number | undefined {
  if (!keyword) return undefined;
  const m = new RegExp(`^${prefix}?0*(\\d{1,9})$`, 'i').exec(keyword.trim());
  return m ? Number(m[1]) : undefined;
}
