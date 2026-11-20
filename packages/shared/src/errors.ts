/** 前后端约定的业务错误码，接口返回 { code, message } */
export const ErrorCode = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  FORBIDDEN: 'FORBIDDEN',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 密码规则：至少 8 位，同时包含字母和数字 */
export const PASSWORD_RULE = {
  minLength: 8,
  pattern: /^(?=.*[A-Za-z])(?=.*\d).{8,64}$/,
  message: '密码至少 8 位，需同时包含字母和数字',
};
