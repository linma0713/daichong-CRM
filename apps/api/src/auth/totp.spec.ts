import { RECOVERY_CODE_PATTERN } from '@crm/shared';
import {
  base32Decode,
  base32Encode,
  generateRecoveryCodes,
  generateTotpSecret,
  otpauthUrl,
  totpCode,
  totpStep,
  verifyTotp,
} from './totp';

/** RFC 6238 附录 B 的 SHA1 测试密钥 */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP', () => {
  it('base32 编解码互逆', () => {
    const buf = Buffer.from('hello world, 两步验证');
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw 6ytb oi')).toEqual(Buffer.from('foobar'));
    expect(() => base32Decode('MZ1')).toThrow();
  });

  it('符合 RFC 6238 测试向量（取后 6 位）', () => {
    const cases: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
    ];
    for (const [t, expected] of cases) {
      expect(totpCode(RFC_SECRET, totpStep(t * 1000), 8)).toBe(expected);
      expect(totpCode(RFC_SECRET, totpStep(t * 1000))).toBe(expected.slice(2));
    }
  });

  it('校验：允许前后差 30 秒，用过的时间片不能再用', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    expect(verifyTotp(secret, totpCode(secret, step), null, now)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 1), null, now)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), null, now)).toBeNull();
    // 重放
    expect(verifyTotp(secret, totpCode(secret, step), step, now)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step + 1), step, now)).toBe(step + 1);
    // 格式
    expect(verifyTotp(secret, '12345', null, now)).toBeNull();
    expect(
      verifyTotp(
        secret,
        `${totpCode(secret, step).slice(0, 3)} ${totpCode(secret, step).slice(3)}`,
        null,
        now,
      ),
    ).toBe(step);
  });

  it('二维码内容和恢复码', () => {
    expect(otpauthUrl('ABC', 'admin')).toBe(
      'otpauth://totp/%E4%BB%A3%E5%85%85CRM%3Aadmin?secret=ABC&issuer=%E4%BB%A3%E5%85%85CRM&algorithm=SHA1&digits=6&period=30',
    );
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const c of codes) expect(c).toMatch(RECOVERY_CODE_PATTERN);
  });
});
