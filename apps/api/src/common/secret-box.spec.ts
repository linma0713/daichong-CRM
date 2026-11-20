import { ConfigService } from '@nestjs/config';
import { SecretBox } from './secret-box';

const box = (key = 'ab'.repeat(32)) =>
  new SecretBox(new ConfigService({ ACCOUNT_SECRET_KEY: key }));

describe('SecretBox', () => {
  it('加密后能解密回原文，且每次密文不同', () => {
    const b = box();
    const a1 = b.encrypt('Pa55word!中文');
    const a2 = b.encrypt('Pa55word!中文');
    expect(a1).not.toBe(a2);
    expect(a1.startsWith('v1:')).toBe(true);
    expect(b.decrypt(a1)).toBe('Pa55word!中文');
  });

  it('换了密钥或密文被改动时解密失败', () => {
    const enc = box().encrypt('secret');
    expect(() => box('cd'.repeat(32)).decrypt(enc)).toThrow();
    const tampered = enc.slice(0, -4) + (enc.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => box().decrypt(tampered)).toThrow();
  });

  it('空值不加密', () => {
    expect(box().encryptOptional('')).toBeNull();
    expect(box().encryptOptional(undefined)).toBeNull();
  });
});
