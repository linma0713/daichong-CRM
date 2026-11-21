import dayjs from 'dayjs';

export function formatTime(value: string | null | undefined): string {
  return value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '—';
}

/** 手机上用的短时间：今年的省掉年份 */
export function formatShortTime(value: string | null | undefined, now = dayjs()): string {
  if (!value) return '—';
  const d = dayjs(value);
  return d.format(d.year() === now.year() ? 'MM-DD HH:mm' : 'YYYY-MM-DD HH:mm');
}

/** 生成一个符合密码规则的随机初始密码（字母 + 数字，10 位） */
export function randomPassword(): string {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = letters + digits;
  const rand = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
  const pick = (set: string) => set[rand(set.length)];
  const chars = [pick(letters), pick(digits)];
  while (chars.length < 10) chars.push(pick(all));
  // 打乱顺序，避免前两位总是「字母 + 数字」
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** 北京时间的「今天」（按日期，不带时刻）。统计都按北京日历算，避免电脑时区不同导致差一天 */
export function beijingToday(now = Date.now()): dayjs.Dayjs {
  return dayjs(new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10));
}

/** 日期区间的快捷选项（财务对账、渠道回报共用） */
export function rangePresets(): { label: string; value: [dayjs.Dayjs, dayjs.Dayjs] }[] {
  const today = beijingToday();
  const lastMonth = today.subtract(1, 'month');
  return [
    { label: '今天', value: [today, today] },
    { label: '昨天', value: [today.subtract(1, 'day'), today.subtract(1, 'day')] },
    { label: '本周', value: [today.startOf('week'), today] },
    { label: '本月', value: [today.startOf('month'), today] },
    { label: '上月', value: [lastMonth.startOf('month'), lastMonth.endOf('month').startOf('day')] },
    { label: '近 30 天', value: [today.subtract(29, 'day'), today] },
  ];
}

/** 万分比 ⇄ 百分比（界面上按 % 填写佣金比例）；null 表示「不单独设置」 */
export function bpToPercent(bp: number | null | undefined): number | null {
  return bp === null || bp === undefined ? null : bp / 100;
}
export function percentToBp(percent: number | null | undefined): number | null {
  return percent === null || percent === undefined ? null : Math.round(percent * 100);
}
