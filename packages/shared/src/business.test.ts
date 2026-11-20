import { describe, expect, it } from 'vitest';
import { displayNo, feeOf, formatCents, parseNo, proratedRefund, termLabel } from './business';

describe('business helpers', () => {
  it('formatCents', () => {
    expect(formatCents(0)).toBe('¥0.00');
    expect(formatCents(123456)).toBe('¥1,234.56');
    expect(formatCents(-5)).toBe('-¥0.05');
    expect(formatCents(2000, '$')).toBe('$20.00');
  });
  it('displayNo / parseNo', () => {
    expect(displayNo('C', 12)).toBe('C00012');
    expect(parseNo('C00012', 'C')).toBe(12);
    expect(parseNo('c12', 'C')).toBe(12);
    expect(parseNo('12', 'C')).toBe(12);
    expect(parseNo('张三', 'C')).toBeUndefined();
    expect(parseNo('D12', 'C')).toBeUndefined();
  });
  it('termLabel', () => {
    expect(termLabel(1)).toBe('月付');
    expect(termLabel(3)).toBe('季付');
    expect(termLabel(12)).toBe('年付');
    expect(termLabel(2)).toBe('2 个月');
  });
});

describe('feeOf', () => {
  it('按万分比四舍五入并加固定金额', () => {
    expect(feeOf(10000, 150)).toBe(150);
    expect(feeOf(2000, 150, 20)).toBe(50);
    expect(feeOf(333, 60)).toBe(2);
  });
  it('金额为 0 或负数时没有手续费', () => {
    expect(feeOf(0, 150, 20)).toBe(0);
  });
});

describe('proratedRefund', () => {
  const start = new Date('2026-11-01T04:00:00Z');
  const end = new Date('2026-12-01T04:00:00Z');
  it('按剩余整天数折算', () => {
    const r = proratedRefund({
      planPaidCents: 30000,
      periodStartAt: start,
      periodEndAt: end,
      at: new Date('2026-11-11T10:00:00Z'),
    });
    expect(r).toEqual({ totalDays: 30, remainingDays: 19, amountCents: 19000 });
  });
  it('扣掉已退金额，不会退成负数；过期为 0', () => {
    const base = { planPaidCents: 30000, periodStartAt: start, periodEndAt: end };
    expect(proratedRefund({ ...base, at: start, refundedCents: 5000 }).amountCents).toBe(25000);
    expect(proratedRefund({ ...base, at: start, refundedCents: 40000 }).amountCents).toBe(0);
    expect(proratedRefund({ ...base, at: new Date('2026-12-05T00:00:00Z') })).toMatchObject({
      remainingDays: 0,
      amountCents: 0,
    });
  });
});
