/** 渠道与营销：渠道平台、转介绍奖励状态 */

/** 渠道所在的平台（渠道本身是具体的账号 / 群 / 投放计划，例如「小红书-主号」） */
export const CHANNEL_PLATFORMS = [
  { value: 'xiaohongshu', label: '小红书' },
  { value: 'douyin', label: '抖音' },
  { value: 'xianyu', label: '闲鱼' },
  { value: 'zhihu', label: '知乎' },
  { value: 'bilibili', label: 'B 站' },
  { value: 'wechat', label: '微信 / 公众号 / 社群' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'search', label: '搜索 / 网站' },
  { value: 'other', label: '其他' },
] as const;
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number]['value'];
export const CHANNEL_PLATFORM_VALUES = CHANNEL_PLATFORMS.map((p) => p.value) as ChannelPlatform[];
export function channelPlatformLabel(value: string): string {
  return CHANNEL_PLATFORMS.find((p) => p.value === value)?.label ?? value;
}

/**
 * 转介绍奖励：老客户推荐的新客户第一次收齐款时自动生成「待发放」，
 * 财务发放（转账或抵扣续费）后变「已发放」；新客户首单全额退款时自动作废。
 */
export type ReferralRewardStatus = 'PENDING' | 'PAID' | 'CANCELLED';
export const REFERRAL_REWARD_STATUSES: ReferralRewardStatus[] = ['PENDING', 'PAID', 'CANCELLED'];
export const REFERRAL_REWARD_STATUS_LABELS: Record<ReferralRewardStatus, string> = {
  PENDING: '待发放',
  PAID: '已发放',
  CANCELLED: '已作废',
};

/** 发放方式：现金类和收款方式一致；discount = 抵扣续费（下次下单时作为优惠，不算营销支出） */
export const REWARD_DISCOUNT = 'discount';

/** 投资回报率 = (收入 − 花费) ÷ 花费；没有花费时为空 */
export function roi(revenueCents: number, costCents: number): number | null {
  return costCents > 0 ? (revenueCents - costCents) / costCents : null;
}
