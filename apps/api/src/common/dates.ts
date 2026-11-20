/**
 * 按自然月加减，月底自动对齐：1 月 31 日 + 1 个月 = 2 月 28/29 日。
 * 以北京时间的日历计算，避免 UTC 跨日导致日期错位。
 */
const TZ_OFFSET_MS = 8 * 3600 * 1000;

export function addMonths(date: Date, months: number): Date {
  const local = new Date(date.getTime() + TZ_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth() + months;
  const day = local.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const target = new Date(
    Date.UTC(
      y,
      m,
      Math.min(day, lastDay),
      local.getUTCHours(),
      local.getUTCMinutes(),
      local.getUTCSeconds(),
      local.getUTCMilliseconds(),
    ),
  );
  return new Date(target.getTime() - TZ_OFFSET_MS);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3600 * 1000);
}

export function addDays(date: Date, days: number): Date {
  return addHours(date, days * 24);
}

/** 北京时间的日期，例如 2026-11-20，用于生成去重键 */
export function localDateKey(date: Date): string {
  return new Date(date.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
}

export function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}
