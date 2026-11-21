/** 前后端约定的业务错误码，接口返回 { code, message } */
export const ErrorCode = {
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',
  FORBIDDEN: 'FORBIDDEN',
  /** 密码或验证码连续输错，账号暂时锁定 */
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  /** 两步验证码不对 */
  TOTP_INVALID: 'TOTP_INVALID',
  /** 输完密码太久没输验证码，要重新输密码 */
  TOTP_CHALLENGE_EXPIRED: 'TOTP_CHALLENGE_EXPIRED',
  /** 角色要求开启两步验证，还没开 */
  TOTP_SETUP_REQUIRED: 'TOTP_SETUP_REQUIRED',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 密码规则：至少 8 位，同时包含字母和数字 */
export const PASSWORD_RULE = {
  minLength: 8,
  pattern: /^(?=.*[A-Za-z])(?=.*\d).{8,64}$/,
  message: '密码至少 8 位，需同时包含字母和数字',
};
