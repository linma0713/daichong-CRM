import { describe, expect, it } from 'vitest';
import { mobilePathFor } from './device';

describe('mobilePathFor 电脑版链接 → 手机版', () => {
  it('有对应页面的转到手机版', () => {
    expect(mobilePathFor('/')).toBe('/m');
    expect(mobilePathFor('/notifications')).toBe('/m/messages');
    expect(mobilePathFor('/tasks')).toBe('/m/tasks');
    expect(mobilePathFor('/tasks?view=open&keyword=T00012')).toBe(
      '/m/tasks?view=all&keyword=T00012',
    );
    expect(mobilePathFor('/customers/abc123')).toBe('/m/customers/abc123');
    expect(mobilePathFor('/customers?view=DORMANT')).toBe('/m/customers?view=recall');
    expect(mobilePathFor('/subscriptions')).toBe('/m/renewals');
  });

  it('没有对应页面的保持电脑版', () => {
    expect(mobilePathFor('/orders/abc')).toBeNull();
    expect(mobilePathFor('/refunds')).toBeNull();
    expect(mobilePathFor('/account/security')).toBeNull();
    expect(mobilePathFor('/customers/abc/edit')).toBeNull();
  });
});
