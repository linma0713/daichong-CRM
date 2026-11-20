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

/** 北京时间，例如 2026-11-20 18:30，用于写进时间线等文字里 */
export function localDateTimeText(date: Date): string {
  return new Date(date.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
}

export function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

/** 北京时间当天 0 点 */
export function startOfLocalDay(date: Date): Date {
  const local = new Date(date.getTime() + TZ_OFFSET_MS);
  return new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - TZ_OFFSET_MS,
  );
}

/** 北京时间当月 1 日 0 点 */
export function startOfLocalMonth(date: Date): Date {
  const local = new Date(date.getTime() + TZ_OFFSET_MS);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - TZ_OFFSET_MS);
}

/** 解析北京时间的日期 2026-11-20，返回那天 0 点；格式不对返回 null */
export function parseLocalDate(text: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - TZ_OFFSET_MS);
  // 2026-02-30 这类不存在的日期会被 Date.UTC 顺延，转回来对不上就算无效
  return localDateKey(start) === text ? start : null;
}
