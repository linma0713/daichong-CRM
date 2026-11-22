import { redact } from './redact';

describe('redact 日志脱敏', () => {
  it('替换密码和令牌字段', () => {
    expect(redact({ username: 'a', password: 'x', newPassword: 'y', refreshToken: 'z' })).toEqual({
      username: 'a',
      password: '***',
      newPassword: '***',
      refreshToken: '***',
    });
  });

  it('替换完整卡号，保留后四位和持卡人', () => {
    expect(redact({ cardNumber: '4242424242424242', last4: '4242', holderName: '王小明' })).toEqual(
      { cardNumber: '***', last4: '4242', holderName: '王小明' },
    );
  });

  it('处理嵌套对象和数组', () => {
    expect(redact({ list: [{ secret: 1, name: 'n' }] })).toEqual({
      list: [{ secret: '***', name: 'n' }],
    });
  });

  it('保留普通字段', () => {
    expect(redact({ displayName: '张三', roleIds: ['r1'] })).toEqual({
      displayName: '张三',
      roleIds: ['r1'],
    });
  });
});
