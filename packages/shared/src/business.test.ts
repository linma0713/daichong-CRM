import { describe, expect, it } from 'vitest';
import { displayNo, feeOf, formatCents, parseNo, termLabel } from './business';

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
