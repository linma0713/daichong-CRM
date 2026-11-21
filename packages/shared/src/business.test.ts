import { describe, expect, it } from 'vitest';
import {
  displayNo,
  feeOf,
  formatCents,
  formatRate,
  parseNo,
  proratedRefund,
  resolveCommissionRates,
  termLabel,
} from './business';

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

describe('resolveCommissionRates', () => {
  const defaults = { first: 1500, renewal: 800, parent: 300 };
  const agent = { status: 'ACTIVE' as const, firstRateBp: null, renewalRateBp: null };
  const parent = { status: 'ACTIVE' as const, parentRateBp: null };

  it('没有单独设置时用全局默认；首单和续费分开', () => {
    expect(resolveCommissionRates({ defaults, agent, parent, firstOrder: true })).toEqual({
      agentRateBp: 1500,
      parentRateBp: 300,
    });
    expect(resolveCommissionRates({ defaults, agent, parent, firstOrder: false })).toEqual({
      agentRateBp: 800,
      parentRateBp: 300,
    });
  });

  it('没有上级时上级比例为 0', () => {
    expect(resolveCommissionRates({ defaults, agent, firstOrder: true }).parentRateBp).toBe(0);
  });

  it('代理单独设置 > 商品设置 > 全局默认', () => {
    const product = { firstRateBp: 1200, renewalRateBp: null, parentRateBp: 200 };
    expect(resolveCommissionRates({ defaults, product, agent, parent, firstOrder: true })).toEqual({
      agentRateBp: 1200,
      parentRateBp: 200,
    });
    expect(
      resolveCommissionRates({
        defaults,
        product,
        agent: { ...agent, firstRateBp: 2000 },
        parent: { ...parent, parentRateBp: 500 },
        firstOrder: true,
      }),
    ).toEqual({ agentRateBp: 2000, parentRateBp: 500 });
    expect(
      resolveCommissionRates({ defaults, product, agent, parent, firstOrder: false }).agentRateBp,
    ).toBe(800);
  });

  it('单独设置成 0 表示不给佣金，不会退回默认值', () => {
    expect(
      resolveCommissionRates({
        defaults,
        agent: { ...agent, renewalRateBp: 0 },
        firstOrder: false,
      }).agentRateBp,
    ).toBe(0);
  });

  it('停用的代理不再产生佣金；上级停用只影响上级', () => {
    expect(
      resolveCommissionRates({
        defaults,
        agent: { ...agent, status: 'DISABLED' },
        parent,
        firstOrder: true,
      }),
    ).toEqual({ agentRateBp: 0, parentRateBp: 0 });
    expect(
      resolveCommissionRates({
        defaults,
        agent,
        parent: { ...parent, status: 'DISABLED' },
        firstOrder: true,
      }),
    ).toEqual({ agentRateBp: 1500, parentRateBp: 0 });
  });
});

describe('formatRate', () => {
  it('万分比转百分比', () => {
    expect(formatRate(1500)).toBe('15%');
    expect(formatRate(750)).toBe('7.5%');
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(1234)).toBe('12.34%');
  });
});
