import { describe, expect, it } from 'vitest';
import { toCsv, yuan } from './csv';

describe('toCsv', () => {
  it('带 BOM，逗号分隔，CRLF 换行', () => {
    expect(
      toCsv([
        ['日期', '收款'],
        ['2026-11-20', 1330],
      ]),
    ).toBe('﻿日期,收款\r\n2026-11-20,1330');
  });

  it('含逗号、引号、换行的文字加引号转义', () => {
    expect(toCsv([['a,b', '他说"好"', '两\n行']])).toBe('﻿"a,b","他说""好""","两\n行"');
  });

  it('防公式注入：= + - @ 开头的文字前加单引号，数字不受影响', () => {
    expect(toCsv([['=SUM(A1)', '@x', '-1', -12.5, null, undefined]])).toBe(
      "﻿'=SUM(A1),'@x,'-1,-12.5,,",
    );
  });
});

describe('yuan', () => {
  it('分转元', () => {
    expect(yuan(133000)).toBe(1330);
    expect(yuan(-198)).toBe(-1.98);
  });
});
