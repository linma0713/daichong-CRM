import { formatCents } from './business';

/** 在线收款链接的状态 */
export type PaymentLinkStatus = 'PENDING' | 'PAID' | 'EXPIRED' | 'CLOSED';
export const PAYMENT_LINK_STATUSES: PaymentLinkStatus[] = ['PENDING', 'PAID', 'EXPIRED', 'CLOSED'];
export const PAYMENT_LINK_STATUS_LABELS: Record<PaymentLinkStatus, string> = {
  PENDING: '等待付款',
  PAID: '已付款',
  EXPIRED: '已过期',
  CLOSED: '已关闭',
};

/**
 * 在线收款通道。先只有模拟通道（测试整个流程用，任何拿到链接的人都能点「付款成功」）；
 * 接真实通道（支付宝、微信支付等）时在这里加一项，后端加一个对应的 PaymentGateway。
 */
export const ONLINE_PAY_CHANNELS = [
  { value: 'off', label: '不开启' },
  { value: 'mock', label: '模拟通道（只用于测试）' },
] as const;
export type OnlinePayChannel = (typeof ONLINE_PAY_CHANNELS)[number]['value'];
export const ONLINE_PAY_CHANNEL_VALUES = ONLINE_PAY_CHANNELS.map(
  (c) => c.value,
) as OnlinePayChannel[];
export const PAY_CHANNEL_LABELS: Record<string, string> = { mock: '模拟通道' };

/** 收款链接有效期（分钟） */
export const PAY_LINK_MINUTES = { min: 5, max: 1440, default: 30 } as const;

/** 有效期的中文说法：30 分钟、2 小时、1 天 */
export function minutesLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

/** 发给客户的付款话术 */
export function payLinkMessage(input: {
  orderCode: string;
  productName: string;
  amountCents: number;
  url: string;
  minutes: number;
}): string {
  return [
    `您好，您的订单 ${input.orderCode}（${input.productName}）需付款 ${formatCents(input.amountCents)}。`,
    `请点击链接付款：${input.url}`,
    `链接 ${minutesLabel(input.minutes)}内有效，付款后系统会自动确认，我们马上为您开通。`,
  ].join('\n');
}
