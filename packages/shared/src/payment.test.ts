import { describe, expect, it } from 'vitest';
import { minutesLabel, payLinkMessage } from './payment';

describe('在线收款', () => {
  it('有效期的说法', () => {
    expect(minutesLabel(30)).toBe('30 分钟');
    expect(minutesLabel(120)).toBe('2 小时');
    expect(minutesLabel(1440)).toBe('1 天');
    expect(minutesLabel(90)).toBe('90 分钟');
  });

  it('付款话术带订单、金额、链接和有效期', () => {
    const text = payLinkMessage({
      orderCode: 'D00012',
      productName: 'Pro 月付（代充）',
      amountCents: 19900,
      url: 'https://crm.example.com/pay/abc',
      minutes: 30,
    });
    expect(text).toContain('D00012（Pro 月付（代充））需付款 ¥199.00');
    expect(text).toContain('https://crm.example.com/pay/abc');
    expect(text).toContain('30 分钟内有效');
  });
});
