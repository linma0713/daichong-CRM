import { addMonths, localDateKey } from './dates';

// 北京时间 = UTC+8
const bj = (s: string) => new Date(`${s}+08:00`);

describe('addMonths', () => {
  it('普通日期加一个月', () => {
    expect(addMonths(bj('2026-11-20T10:00:00'), 1)).toEqual(bj('2026-12-20T10:00:00'));
  });
  it('跨年', () => {
    expect(addMonths(bj('2026-11-20T10:00:00'), 3)).toEqual(bj('2027-02-20T10:00:00'));
    expect(addMonths(bj('2026-11-20T10:00:00'), 12)).toEqual(bj('2027-11-20T10:00:00'));
  });
  it('月底对齐到下个月最后一天', () => {
    expect(addMonths(bj('2027-01-31T09:00:00'), 1)).toEqual(bj('2027-02-28T09:00:00'));
    expect(addMonths(bj('2028-01-31T09:00:00'), 1)).toEqual(bj('2028-02-29T09:00:00'));
  });
  it('北京时间凌晨（UTC 还是前一天）按北京日期计算', () => {
    expect(addMonths(bj('2026-12-01T01:00:00'), 1)).toEqual(bj('2027-01-01T01:00:00'));
    expect(localDateKey(bj('2026-12-01T01:00:00'))).toBe('2026-12-01');
  });
});
