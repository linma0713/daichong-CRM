import { describe, expect, it } from 'vitest';
import { parseAccountLines } from './parse';

describe('parseAccountLines', () => {
  it('支持 ---- / Tab / 逗号 / 空格分隔，第三段起当作其他信息', () => {
    const { rows, bad } = parseAccountLines(
      'a@x.com----p1\nb@x.com\tp2\n\nc@x.com,p3,恢复邮箱 r@x.com\n d@x.com  p4 ',
    );
    expect(bad).toEqual([]);
    expect(rows).toEqual([
      { email: 'a@x.com', password: 'p1', secretNote: undefined },
      { email: 'b@x.com', password: 'p2', secretNote: undefined },
      { email: 'c@x.com', password: 'p3', secretNote: '恢复邮箱 r@x.com' },
      { email: 'd@x.com', password: 'p4', secretNote: undefined },
    ]);
  });
  it('缺密码或邮箱不对的行单独列出', () => {
    const { rows, bad } = parseAccountLines('only@x.com\nnot-an-email----pw');
    expect(rows).toEqual([]);
    expect(bad).toEqual(['only@x.com', 'not-an-email----pw']);
  });
});
