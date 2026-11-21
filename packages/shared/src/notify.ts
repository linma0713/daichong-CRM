/**
 * 消息通知：业务事件目录。站内消息按事件发给相关员工；
 * 企业微信群机器人可以按事件订阅，同一个事件同时推到群里。
 */
export interface NotifyEventDef {
  value: NotifyEvent;
  label: string;
  /** 站内消息发给谁，显示在设置页帮助员工理解 */
  audience: string;
  group: '履约' | '售后' | '库存' | '代理' | '收款' | '营销' | '安全' | '汇总';
}

export type NotifyEvent =
  | 'task.created'
  | 'task.assigned'
  | 'task.overdue'
  | 'task.failed'
  | 'task.done'
  | 'payment.received'
  | 'ticket.created'
  | 'ticket.escalated'
  | 'refund.requested'
  | 'refund.decided'
  | 'inventory.low'
  | 'statement.generated'
  | 'referral.created'
  | 'security.new_device'
  | 'security.locked'
  | 'daily.digest';

export const NOTIFY_EVENTS: NotifyEventDef[] = [
  {
    value: 'task.created',
    label: '新的开通 / 续费任务',
    audience: '派到的充值员；没人接时发给所有充值员',
    group: '履约',
  },
  { value: 'task.assigned', label: '任务转交', audience: '接手的充值员', group: '履约' },
  {
    value: 'task.overdue',
    label: '任务超时未完成',
    audience: '负责的充值员；没人接时发给所有充值员',
    group: '履约',
  },
  { value: 'task.failed', label: '任务处理失败', audience: '订单的负责客服', group: '履约' },
  {
    value: 'task.done',
    label: '开通 / 续费完成',
    audience: '订单的负责客服（提醒交付客户）',
    group: '履约',
  },
  {
    value: 'payment.received',
    label: '收到客户付款',
    audience: '订单的负责客服（别人代确认或在线到账时）',
    group: '收款',
  },
  { value: 'ticket.created', label: '新的售后工单', audience: '负责处理的售后', group: '售后' },
  {
    value: 'ticket.escalated',
    label: '售后工单超时升级',
    audience: '负责处理的售后和工单负责人',
    group: '售后',
  },
  {
    value: 'refund.requested',
    label: '退款待审批',
    audience: '有审批退款权限的员工',
    group: '售后',
  },
  { value: 'refund.decided', label: '退款审批结果', audience: '申请退款的员工', group: '售后' },
  {
    value: 'inventory.low',
    label: '付款资源余额或成品号库存不足',
    audience: '有入库权限的员工',
    group: '库存',
  },
  {
    value: 'statement.generated',
    label: '生成了佣金对账单',
    audience: '有佣金结算权限的员工',
    group: '代理',
  },
  {
    value: 'referral.created',
    label: '转介绍奖励待发放',
    audience: '有渠道与营销权限的员工',
    group: '营销',
  },
  {
    value: 'security.new_device',
    label: '账号在新设备登录',
    audience: '登录的员工本人',
    group: '安全',
  },
  {
    value: 'security.locked',
    label: '账号因输错密码被锁定',
    audience: '被锁定的员工和能管理员工的人',
    group: '安全',
  },
  {
    value: 'daily.digest',
    label: '每日早报（只推群，不发站内消息）',
    audience: '只推到订阅了它的群',
    group: '汇总',
  },
];

export const NOTIFY_EVENT_VALUES = NOTIFY_EVENTS.map((e) => e.value);
export const NOTIFY_EVENT_LABELS = Object.fromEntries(
  NOTIFY_EVENTS.map((e) => [e.value, e.label]),
) as Record<NotifyEvent, string>;

/** 新建群机器人时默认勾选的事件：需要有人马上处理的 */
export const DEFAULT_GROUP_EVENTS: NotifyEvent[] = [
  'task.created',
  'task.overdue',
  'ticket.escalated',
  'refund.requested',
  'inventory.low',
  'daily.digest',
];

export type OutboundStatus = 'PENDING' | 'SENT' | 'FAILED';
export const OUTBOUND_STATUS_LABELS: Record<OutboundStatus, string> = {
  PENDING: '待发送',
  SENT: '已发送',
  FAILED: '发送失败',
};

/**
 * 企业微信群机器人地址：https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx
 * 只认这个域名，避免把消息推到别处。
 */
export function parseWecomWebhook(url: string): { key: string } | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 'qyapi.weixin.qq.com') return null;
  if (u.pathname !== '/cgi-bin/webhook/send') return null;
  const key = u.searchParams.get('key');
  if (!key || !/^[A-Za-z0-9-]{8,64}$/.test(key)) return null;
  return { key };
}

/** 界面上只显示 key 的头尾几位 */
export function maskWebhookKey(key: string): string {
  return key.length <= 8 ? '****' : `${key.slice(0, 4)}****${key.slice(-4)}`;
}
