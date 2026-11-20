import { addDays } from '../common/dates';

const DAY_MS = 24 * 3600 * 1000;

/** 到期后多少天内还提醒客服做一次挽回 */
export const EXPIRED_FOLLOW_DAYS = 7;

/** 剩余天数：还剩不到 1 天算 1 天；今天刚到期算 0；到期 2 天算 -2 */
export function daysLeft(endAt: Date, now: Date): number {
  const diff = endAt.getTime() - now.getTime();
  return diff > 0 ? Math.ceil(diff / DAY_MS) : -Math.floor(-diff / DAY_MS) || 0;
}

export interface ReminderInput {
  status: string;
  endAt: Date;
  /** 最近一次「续费提醒」跟进记录的时间 */
  lastRemindedAt: Date | null;
  /** 已有待收款 / 开通中的续费订单，说明已经在跟进 */
  hasOpenRenewal: boolean;
}

/**
 * 是否需要提醒客服跟进续费。按设置里的提醒节奏（例如到期前 7 / 3 / 1 天）分阶段：
 * 进入一个阶段后，只要这个阶段里还没写过续费提醒，就算「需要提醒」；
 * 到期后 7 天内再提醒一次挽回。已经下了续费订单的不再提醒。
 */
export function needsReminder(input: ReminderInput, reminderDays: number[], now: Date): boolean {
  if (input.hasOpenRenewal) return false;
  if (input.status !== 'ACTIVE' && input.status !== 'EXPIRED') return false;
  const msLeft = input.endAt.getTime() - now.getTime();
  let stageStart: Date | null = null;
  if (msLeft <= 0) {
    if (-msLeft <= EXPIRED_FOLLOW_DAYS * DAY_MS) stageStart = input.endAt;
  } else {
    const stage = [...reminderDays].sort((a, b) => a - b).find((d) => msLeft <= d * DAY_MS);
    if (stage !== undefined) stageStart = addDays(input.endAt, -stage);
  }
  if (!stageStart) return false;
  return !input.lastRemindedAt || input.lastRemindedAt.getTime() < stageStart.getTime();
}
