import { describe, expect, it } from 'vitest';
import { maskWebhookKey, NOTIFY_EVENT_VALUES, parseWecomWebhook } from './notify';

describe('parseWecomWebhook', () => {
  it('accepts the official robot address', () => {
    expect(
      parseWecomWebhook(
        ' https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa ',
      ),
    ).toEqual({ key: '693a91f6-7xxx-4bc4-97a0-0ec2sifa5aaa' });
  });
  it('rejects other hosts, paths and schemes', () => {
    expect(parseWecomWebhook('http://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abcdefgh')).toBe(
      null,
    );
    expect(parseWecomWebhook('https://evil.example.com/cgi-bin/webhook/send?key=abcdefgh')).toBe(
      null,
    );
    expect(
      parseWecomWebhook('https://qyapi.weixin.qq.com.evil.com/cgi-bin/webhook/send?key=a'),
    ).toBe(null);
    expect(parseWecomWebhook('https://qyapi.weixin.qq.com/cgi-bin/other?key=abcdefgh')).toBe(null);
    expect(parseWecomWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send')).toBe(null);
    expect(parseWecomWebhook('not a url')).toBe(null);
  });
  it('masks keys', () => {
    expect(maskWebhookKey('693a91f6-7xxx-4bc4')).toBe('693a****4bc4');
    expect(maskWebhookKey('short')).toBe('****');
  });
  it('event values are unique', () => {
    expect(new Set(NOTIFY_EVENT_VALUES).size).toBe(NOTIFY_EVENT_VALUES.length);
  });
});
