/** 登录安全的约定：前后端共用 */

/** 密码或两步验证码连续输错几次锁定账号、锁多久 */
export const LOGIN_LOCK = { maxFailures: 5, minutes: 15 } as const;

/** 两步验证：恢复码个数；验证码 6 位、30 秒一换 */
export const TOTP_RECOVERY_CODE_COUNT = 8;
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
/** 扫码后验证器里显示的名称 */
export const TOTP_ISSUER = '代充CRM';

/** 恢复码：xxxx-xxxx，小写字母 + 数字，去掉容易看错的 0 o 1 l */
export const RECOVERY_CODE_PATTERN = /^[a-km-np-z2-9]{4}-?[a-km-np-z2-9]{4}$/i;

/** 用户输入的恢复码统一成 xxxx-xxxx 小写 */
export function normalizeRecoveryCode(input: string): string | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, '');
  if (!RECOVERY_CODE_PATTERN.test(s)) return null;
  const raw = s.replace('-', '');
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

/**
 * 浏览器标识 → 「Chrome · Windows」这种好认的设备名。只认常见的几种，认不出就显示「未知设备」。
 */
export function describeUserAgent(ua: string | null | undefined): string {
  if (!ua) return '未知设备';
  const os = /iPhone|iPad|iPod/.test(ua)
    ? /iPad/.test(ua)
      ? 'iPad'
      : 'iPhone'
    : /Android/.test(ua)
      ? 'Android'
      : /HarmonyOS|OpenHarmony/.test(ua)
        ? '鸿蒙'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  const app = /MicroMessenger/.test(ua)
    ? '微信'
    : /DingTalk/.test(ua)
      ? '钉钉'
      : /Edg\//.test(ua)
        ? 'Edge'
        : /OPR\/|Opera/.test(ua)
          ? 'Opera'
          : /Firefox\//.test(ua)
            ? 'Firefox'
            : /QQBrowser/.test(ua)
              ? 'QQ 浏览器'
              : /Chrome\/|CriOS\//.test(ua)
                ? 'Chrome'
                : /Safari\//.test(ua)
                  ? 'Safari'
                  : /^(curl|Wget|python|node|axios|okhttp)/i.test(ua)
                    ? '程序调用'
                    : null;
  if (!os && !app) return '未知设备';
  return [app, os].filter(Boolean).join(' · ');
}
