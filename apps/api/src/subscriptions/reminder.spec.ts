import { daysLeft, needsReminder } from './reminder';

const bj = (s: string) => new Date(`${s}+08:00`);
const endAt = bj('2026-12-20T10:00:00');
const base = { status: 'ACTIVE', endAt, lastRemindedAt: null, hasOpenRenewal: false };
const days = [7, 3, 1];

describe('daysLeft', () => {
  it('不足一天按一天算，到期后为 0 或负数', () => {
    expect(daysLeft(endAt, bj('2026-12-19T22:00:00'))).toBe(1);
    expect(daysLeft(endAt, bj('2026-12-13T10:00:00'))).toBe(7);
    expect(daysLeft(endAt, bj('2026-12-20T22:00:00'))).toBe(0);
    expect(daysLeft(endAt, bj('2026-12-22T11:00:00'))).toBe(-2);
  });
});

describe('needsReminder', () => {
  it('离到期超过最大提醒天数时不提醒', () => {
    expect(needsReminder(base, days, bj('2026-12-10T10:00:00'))).toBe(false);
  });

  it('进入 7 天阶段后提醒，写过提醒后本阶段不再提醒', () => {
    const now = bj('2026-12-14T10:00:00');
    expect(needsReminder(base, days, now)).toBe(true);
    expect(needsReminder({ ...base, lastRemindedAt: bj('2026-12-14T09:00:00') }, days, now)).toBe(
      false,
    );
  });

  it('进入 3 天阶段后，7 天阶段的提醒不算数', () => {
    const now = bj('2026-12-18T10:00:00');
    expect(needsReminder({ ...base, lastRemindedAt: bj('2026-12-14T09:00:00') }, days, now)).toBe(
      true,
    );
  });

  it('到期后 7 天内再提醒一次，超过 7 天不再提醒', () => {
    const remindedBefore = {
      ...base,
      status: 'EXPIRED',
      lastRemindedAt: bj('2026-12-19T12:00:00'),
    };
    expect(needsReminder(remindedBefore, days, bj('2026-12-22T10:00:00'))).toBe(true);
    expect(needsReminder(remindedBefore, days, bj('2026-12-28T11:00:00'))).toBe(false);
  });

  it('已有续费订单或订阅已终止时不提醒', () => {
    const now = bj('2026-12-18T10:00:00');
    expect(needsReminder({ ...base, hasOpenRenewal: true }, days, now)).toBe(false);
    expect(needsReminder({ ...base, status: 'CANCELLED' }, days, now)).toBe(false);
  });
});
