import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import {
  TOTP_DIGITS,
  TOTP_ISSUER,
  TOTP_PERIOD_SECONDS,
  TOTP_RECOVERY_CODE_COUNT,
} from '@crm/shared';

/**
 * 两步验证（TOTP，RFC 6238）：和微信 / 支付宝里的「身份验证器」、Google Authenticator、
 * Microsoft Authenticator 通用。算法很短，自己实现，不引第三方包。
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('密钥格式不对');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 新密钥：20 字节（160 位），base32 显示 */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(now = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
}

export function totpCode(secret: string, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(bin).padStart(digits, '0');
}

/**
 * 校验验证码：允许前后各差一个时间片（手机时间不准）。
 * 返回匹配到的时间片；同一个时间片（或更早的）用过就不能再用，防止验证码被截获后重放。
 */
export function verifyTotp(
  secret: string,
  code: string,
  lastStep: number | null,
  now = Date.now(),
): number | null {
  const clean = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const current = totpStep(now);
  for (const step of [current - 1, current, current + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    if (totpCode(secret, step) === clean) return step;
  }
  return null;
}

/** 验证器扫的二维码内容 */
export function otpauthUrl(secret: string, account: string): string {
  const label = encodeURIComponent(`${TOTP_ISSUER}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer: TOTP_ISSUER,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

const RECOVERY_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

/** 恢复码：xxxx-xxxx，去掉 0 o 1 l 这些容易看错的字符 */
export function generateRecoveryCodes(count = TOTP_RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const s = Array.from({ length: 8 }, () => RECOVERY_ALPHABET[randomInt(32)]).join('');
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

export const hashRecoveryCode = (code: string) => createHash('sha256').update(code).digest('hex');
