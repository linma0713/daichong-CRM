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
  login(username: string, password: string): Promise<Profile>;
  logout(): Promise<void>;
  /** 是否拥有这些权限（需同时满足） */
  can(...permissions: string[]): boolean;
  /** 修改资料或密码后刷新登录信息 */
  reload(): Promise<unknown>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
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

  const login = useCallback(
    async (username: string, password: string) => {
      const res = await unwrap(api.POST('/api/auth/login', { body: { username, password } }));
      tokenStore.save(res);
      queryClient.setQueryData(ME_KEY, res.user);
      setAuthed(true);
      return res.user;
    },
    [queryClient],
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
