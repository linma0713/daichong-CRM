import dayjs from 'dayjs';

export function formatTime(value: string | null | undefined): string {
  return value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '—';
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
