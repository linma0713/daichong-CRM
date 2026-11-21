import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, setSessionExpiredHandler, unwrap, type Schemas } from '../api/client';
import { tokenStore } from './token-store';
import { can as canWith } from './permissions';

export type Profile = Schemas['ProfileDto'];

interface AuthContextValue {
  /** 当前登录的员工；未登录为 null */
  profile: Profile | null;
  /** 正在加载登录信息 */
  loading: boolean;
  /** 加载登录信息失败（非登录过期，例如后端没启动） */
  error: unknown;
  /** 第一步：密码。开了两步验证的账号返回 challenge，再调 loginTotp */
  login(username: string, password: string): Promise<LoginResult>;
  /** 第二步：两步验证码或恢复码 */
  loginTotp(challenge: string, code: string): Promise<Profile>;
  logout(): Promise<void>;
  /** 是否拥有这些权限（需同时满足） */
  can(...permissions: string[]): boolean;
  /** 修改资料或密码后刷新登录信息 */
  reload(): Promise<unknown>;
}

export type LoginResult =
  { totpRequired: true; challenge: string } | { totpRequired: false; user: Profile };

const AuthContext = createContext<AuthContextValue | null>(null);

/** 浏览器的设备编号：第一次打开时随机生成，后端用它判断是不是新设备登录 */
function deviceId(): string | undefined {
  try {
    let id = localStorage.getItem('crm.deviceId');
    if (!id) {
      // 局域网 http 访问时没有 crypto.randomUUID，用 getRandomValues
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem('crm.deviceId', id);
    }
    return id;
  } catch {
    return undefined;
  }
}
export const ME_KEY = ['auth', 'me'] as const;

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [authed, setAuthed] = useState(() => Boolean(tokenStore.access));

  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: () => unwrap(api.GET('/api/auth/me')),
    enabled: authed,
    staleTime: 60_000,
    retry: false,
  });

  const signOutLocally = useCallback(() => {
    tokenStore.clear();
    setAuthed(false);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    setSessionExpiredHandler(signOutLocally);
    return () => setSessionExpiredHandler(null);
  }, [signOutLocally]);

  const finish = useCallback(
    (res: Schemas['LoginResponseDto']): Profile => {
      if (!res.accessToken || !res.refreshToken || !res.user) throw new Error('登录返回不完整');
      tokenStore.save({ accessToken: res.accessToken, refreshToken: res.refreshToken });
      queryClient.setQueryData(ME_KEY, res.user);
      setAuthed(true);
      return res.user;
    },
    [queryClient],
  );

  const login = useCallback(
    async (username: string, password: string): Promise<LoginResult> => {
      const res = await unwrap(
        api.POST('/api/auth/login', { body: { username, password, deviceId: deviceId() } }),
      );
      if (res.totpRequired && res.challenge)
        return { totpRequired: true, challenge: res.challenge };
      return { totpRequired: false, user: finish(res) };
    },
    [finish],
  );

  const loginTotp = useCallback(
    async (challenge: string, code: string) =>
      finish(
        await unwrap(
          api.POST('/api/auth/login/totp', { body: { challenge, code, deviceId: deviceId() } }),
        ),
      ),
    [finish],
  );

  const logout = useCallback(async () => {
    try {
      await api.POST('/api/auth/logout');
    } catch {
      // 网络问题也照样退出本地登录
    }
    signOutLocally();
  }, [signOutLocally]);

  const profile = authed ? (me.data ?? null) : null;
  const value: AuthContextValue = {
    profile,
    loading: authed && me.isPending,
    error: authed ? me.error : null,
    login,
    loginTotp,
    logout,
    can: (...permissions) => Boolean(profile && canWith(profile.permissions, ...permissions)),
    reload: () => queryClient.invalidateQueries({ queryKey: ME_KEY }),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 里使用');
  return ctx;
}
