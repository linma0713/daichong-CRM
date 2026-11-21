import { type ReactNode, useEffect } from 'react';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, errorMessage } from './api/errors';
import { AuthProvider, ME_KEY } from './auth/AuthProvider';

dayjs.locale('zh-cn');

/** 接口出错时统一弹提示；由 ErrorBridge 接到 antd 的 message 上 */
let notifyError: (text: string) => void = (text) => console.error(text);

/** 管理员刚要求改密码 / 开两步验证：重新拉登录信息，页面守卫会带员工去设置 */
const SETUP_REQUIRED = ['PASSWORD_CHANGE_REQUIRED', 'TOTP_SETUP_REQUIRED'];

function shouldNotify(err: unknown): boolean {
  if (err instanceof ApiError && err.code && SETUP_REQUIRED.includes(err.code)) {
    void queryClient.invalidateQueries({ queryKey: ME_KEY });
    return false;
  }
  // 401 会自动跳转登录页，不重复提示
  return !(err instanceof ApiError && err.status === 401);
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    // meta.silent：页面自己显示错误（例如客户付款页），不再弹提示
    onError: (err, query) =>
      !query.meta?.silent && shouldNotify(err) && notifyError(errorMessage(err)),
  }),
  mutationCache: new MutationCache({
    onError: (err, _vars, _ctx, mutation) => {
      if (mutation.meta?.silent || !shouldNotify(err)) return;
      notifyError(errorMessage(err));
    },
  }),
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

function ErrorBridge() {
  const { message } = AntApp.useApp();
  useEffect(() => {
    notifyError = (text) => void message.error(text);
  }, [message]);
  return null;
}

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#1677ff', borderRadius: 6 } }}>
      <AntApp>
        <ErrorBridge />
        <QueryClientProvider client={queryClient}>
          <AuthProvider>{children}</AuthProvider>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  );
}
