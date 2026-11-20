import { type ReactNode, useEffect } from 'react';
import { App as AntApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, errorMessage } from './api/errors';
import { AuthProvider } from './auth/AuthProvider';

dayjs.locale('zh-cn');

/** 接口出错时统一弹提示；由 ErrorBridge 接到 antd 的 message 上 */
let notifyError: (text: string) => void = (text) => console.error(text);

function shouldNotify(err: unknown): boolean {
  // 401 会自动跳转登录页，不重复提示
  return !(err instanceof ApiError && err.status === 401);
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (err) => shouldNotify(err) && notifyError(errorMessage(err)),
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
