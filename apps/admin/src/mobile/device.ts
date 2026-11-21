/**
 * 手机版和电脑版的切换：手机上默认用手机版，员工点过「电脑版」就记住，不再自动跳。
 * 只记在这台设备的浏览器里，读写失败（隐私模式等）就按默认处理。
 */
const PREF_KEY = 'crm.ui';

export type UiPref = 'mobile' | 'desktop';

export function getUiPref(): UiPref | null {
  try {
    const v = localStorage.getItem(PREF_KEY);
    return v === 'mobile' || v === 'desktop' ? v : null;
  } catch {
    return null;
  }
}

export function setUiPref(pref: UiPref): void {
  try {
    localStorage.setItem(PREF_KEY, pref);
  } catch {
    // 存不了就算了，只是下次还会按默认判断
  }
}

/** 手机：屏幕窄且是触屏。平板和电脑上的窄窗口不算 */
export function isPhone(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return (
    window.matchMedia('(max-width: 767px)').matches &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

/** 这台设备现在该不该用手机版 */
export function prefersMobile(): boolean {
  const pref = getUiPref();
  return pref ? pref === 'mobile' : isPhone();
}

/**
 * 电脑版地址 → 手机版里对应的页面；没有对应页面返回 null（继续用电脑版页面，也能在手机上看）。
 * 用在消息链接、企业微信推送链接上。
 */
export function mobilePathFor(link: string): string | null {
  const url = new URL(link, 'http://x');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const q = url.searchParams;
  if (path === '/') return '/m';
  if (path === '/notifications') return '/m/messages';
  if (path === '/tasks') {
    const keyword = q.get('keyword');
    return keyword ? `/m/tasks?view=all&keyword=${encodeURIComponent(keyword)}` : '/m/tasks';
  }
  if (path === '/customers')
    return q.get('view') === 'DORMANT' ? '/m/customers?view=recall' : '/m/customers';
  const customer = path.match(/^\/customers\/([^/]+)$/);
  if (customer) return `/m/customers/${customer[1]}`;
  if (path === '/subscriptions') return '/m/renewals';
  return null;
}
