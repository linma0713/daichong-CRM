import { planReduction, type ReducibleRow } from './engine';

const d = (day: number) => new Date(Date.UTC(2026, 10, day));
const row = (
  id: string,
  status: ReducibleRow['status'],
  amount: number,
  day: number,
): ReducibleRow => ({
  id,
  kind: 'ACCRUAL',
  status,
  originalCents: amount,
  amountCents: amount,
  releaseAt: d(day),
});

describe('planReduction 退款扣减佣金', () => {
  it('冻结期内全额退款：佣金全部作废', () => {
    const plan = planReduction([row('a', 'FROZEN', 15000, 10)], 100000, 100000);
    expect(plan).toEqual({
      totalCents: 15000,
      updates: [{ id: 'a', amountCents: 0, status: 'VOID' }],
      clawbackCents: 0,
    });
  });

  it('部分退款按比例扣：退一半，佣金扣一半', () => {
    const plan = planReduction([row('a', 'FROZEN', 15000, 10)], 50000, 100000);
    expect(plan.updates).toEqual([{ id: 'a', amountCents: 7500, status: 'FROZEN' }]);
  });

  it('按月释放的：先扣最晚解冻的，冻结中的扣完再扣可结算的', () => {
    const rows = [
      row('m1', 'RELEASABLE', 1000, 1),
      row('m2', 'FROZEN', 1000, 2),
      row('m3', 'FROZEN', 1000, 3),
    ];
    // 退 80%：佣金 3000 要扣 2400
    const plan = planReduction(rows, 80000, 100000);
    expect(plan.updates).toEqual([
      { id: 'm3', amountCents: 0, status: 'VOID' },
      { id: 'm2', amountCents: 0, status: 'VOID' },
      { id: 'm1', amountCents: 600, status: 'RELEASABLE' },
    ]);
    expect(plan.clawbackCents).toBe(0);
  });

  it('已发放的扣不动：记扣回，下次对账抵扣', () => {
    const plan = planReduction([row('a', 'PAID', 15000, 1)], 100000, 100000);
    expect(plan).toEqual({ totalCents: 15000, updates: [], clawbackCents: 15000 });
  });

  it('按累计退款算：已经扣过的不重复扣；退款超过基数按全额算', () => {
    const rows: ReducibleRow[] = [
      { ...row('a', 'PAID', 15000, 1) },
      {
        id: 'c',
        kind: 'CLAWBACK',
        status: 'RELEASABLE',
        originalCents: -7500,
        amountCents: -7500,
        releaseAt: d(5),
      },
    ];
    expect(planReduction(rows, 50000, 100000).totalCents).toBe(0);
    expect(planReduction(rows, 120000, 100000)).toMatchObject({
      totalCents: 7500,
      clawbackCents: 7500,
    });
  });
});
