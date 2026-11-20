/** 登录令牌存在浏览器本地，刷新页面不用重新登录 */
const ACCESS_KEY = 'crm.accessToken';
const REFRESH_KEY = 'crm.refreshToken';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export const tokenStore = {
  get access(): string | null {
    return safeGet(ACCESS_KEY);
  },
  get refresh(): string | null {
    return safeGet(REFRESH_KEY);
  },
  save(pair: TokenPair): void {
    try {
      localStorage.setItem(ACCESS_KEY, pair.accessToken);
      localStorage.setItem(REFRESH_KEY, pair.refreshToken);
    } catch {
      // 无痕模式等情况下存不了，只影响刷新页面后需要重新登录
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(ACCESS_KEY);
      localStorage.removeItem(REFRESH_KEY);
    } catch {
      // 忽略
    }
  },
};
