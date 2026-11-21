import { describe, expect, it } from 'vitest';
import { describeUserAgent, normalizeRecoveryCode } from './security';

describe('describeUserAgent', () => {
  it('常见浏览器和系统', () => {
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ),
    ).toBe('Chrome · Windows');
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
      ),
    ).toBe('Safari · Mac');
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
      ),
    ).toBe('Edge · Windows');
    expect(
      describeUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50',
      ),
    ).toBe('微信 · iPhone');
    expect(
      describeUserAgent(
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome · Android');
  });

  it('认不出或没有', () => {
    expect(describeUserAgent(null)).toBe('未知设备');
    expect(describeUserAgent('something')).toBe('未知设备');
    expect(describeUserAgent('curl/8.5.0')).toBe('程序调用');
  });
});

describe('normalizeRecoveryCode', () => {
  it('大小写、空格、有无短横线都认', () => {
    expect(normalizeRecoveryCode(' AB3K-9XQZ ')).toBe('ab3k-9xqz');
    expect(normalizeRecoveryCode('ab3k9xqz')).toBe('ab3k-9xqz');
    expect(normalizeRecoveryCode('ab3k 9xqz')).toBe('ab3k-9xqz');
  });

  it('格式不对返回 null', () => {
    expect(normalizeRecoveryCode('123456')).toBeNull();
    expect(normalizeRecoveryCode('ab3k-9xq0')).toBeNull();
  });
});
