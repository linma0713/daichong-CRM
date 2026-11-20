import { describe, expect, it } from 'vitest';
import { formatYuanTick, niceTicks } from './chart-scale';

describe('niceTicks', () => {
  it('步长取 1 / 2 / 5 × 10ⁿ，顶端盖住最大值', () => {
    expect(niceTicks(133000)).toEqual([0, 50000, 100000, 150000]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(0.9)).toEqual([0, 0.5, 1]);
  });

  it('计数刻度至少为 1；全是 0 时给一个空刻度', () => {
    expect(niceTicks(2, 4, true)).toEqual([0, 1, 2]);
    expect(niceTicks(0)).toEqual([0, 1]);
  });
});

describe('formatYuanTick', () => {
  it('一万以下写全，以上写万', () => {
    expect(formatYuanTick(500000)).toBe('¥5,000');
    expect(formatYuanTick(1500000)).toBe('1.5万');
    expect(formatYuanTick(0)).toBe('¥0');
  });
});
