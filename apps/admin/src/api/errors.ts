/** 后端返回的错误统一转成 ApiError，页面上直接展示 message */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ErrorBody {
  message?: string | string[];
  code?: string;
}

const STATUS_MESSAGES: Record<number, string> = {
  401: '登录已过期，请重新登录',
  403: '没有权限执行这个操作',
  404: '要找的数据不存在',
  429: '操作太频繁，请稍后再试',
};

export function toApiError(body: unknown, status: number): ApiError {
  const b = (body ?? {}) as ErrorBody;
  const raw = Array.isArray(b.message) ? b.message.join('；') : b.message;
  const message =
    raw || STATUS_MESSAGES[status] || (status >= 500 ? '服务器出错了，请稍后再试' : '请求失败');
  return new ApiError(message, status, b.code);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof TypeError) return '连不上服务器，请检查网络或后端是否启动';
  return err instanceof Error ? err.message : '发生未知错误';
}
