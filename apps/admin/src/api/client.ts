import createClient from 'openapi-fetch';
import type { components, paths } from './schema';
import { tokenStore } from '../auth/token-store';
import { toApiError } from './errors';

export type Schemas = components['schemas'];

/** GET 接口的查询参数类型，例如 QueryOf<'/api/orders'> */
export type QueryOf<P extends keyof paths> = paths[P] extends {
  get: { parameters: { query?: infer Q } };
}
  ? NonNullable<Q>
  : never;

/** 登录状态失效时的回调，由 AuthProvider 注册（跳回登录页） */
let onSessionExpired: (() => void) | null = null;
export function setSessionExpiredHandler(fn: (() => void) | null): void {
  onSessionExpired = fn;
}

const NO_REFRESH_PATHS = ['/api/auth/login', '/api/auth/login/totp', '/api/auth/refresh'];

/** 同一时刻只发一个刷新请求，其他请求等它的结果 */
let refreshing: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
  const refreshToken = tokenStore.refresh;
  if (!refreshToken) return false;
  try {
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    tokenStore.save((await res.json()) as Schemas['TokenPairDto']);
    return true;
  } catch {
    return false;
  }
}

function refreshOnce(): Promise<boolean> {
  refreshing ??= refreshTokens().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** 自动带上令牌；令牌过期时先刷新再重试一次，刷新失败就退出登录 */
async function authFetch(request: Request): Promise<Response> {
  const retry = request.clone();
  const token = tokenStore.access;
  if (token) request.headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(request);

  const path = new URL(request.url).pathname;
  if (response.status !== 401 || NO_REFRESH_PATHS.includes(path)) return response;

  if (await refreshOnce()) {
    retry.headers.set('Authorization', `Bearer ${tokenStore.access}`);
    return fetch(retry);
  }
  tokenStore.clear();
  onSessionExpired?.();
  return response;
}

export const api = createClient<paths>({ baseUrl: window.location.origin, fetch: authFetch });

/** 把 openapi-fetch 的返回值拆开：成功返回数据，失败抛出 ApiError */
export async function unwrap<T>(
  promise: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await promise;
  if (error !== undefined || !response.ok) throw toApiError(error, response.status);
  return data as T;
}

/**
 * 不走 openapi-fetch 的请求（上传文件、下载附件），同样自动带令牌、过期自动刷新。
 * path 以 /api 开头。
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return authFetch(new Request(new URL(path, window.location.origin), init));
}
