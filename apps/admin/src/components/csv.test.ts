import { describe, expect, it } from 'vitest';
import { parseTable, toCsv, yuan } from './csv';

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

describe('parseTable', () => {
  it('逗号分隔，去 BOM，兼容 CRLF / LF，空行保留、末尾换行不多出一行', () => {
    expect(parseTable('\uFEFF称呼,微信\r\n小王,wx1\n\n小李,\r\n')).toEqual([
      ['称呼', '微信'],
      ['小王', 'wx1'],
      [''],
      ['小李', ''],
    ]);
  });

  it('引号里的逗号、换行和转义引号', () => {
    expect(parseTable('a,b\n"x,y","他说""好""\n第二行"')).toEqual([
      ['a', 'b'],
      ['x,y', '他说"好"\n第二行'],
    ]);
  });

  it('从 Excel 复制的制表符文本，单元格里的逗号原样保留', () => {
    expect(parseTable('称呼\t标签\n小王\tVIP,老客\n')).toEqual([
      ['称呼', '标签'],
      ['小王', 'VIP,老客'],
    ]);
  });

  it('和 toCsv 互通', () => {
    const rows = [
      ['称呼', '备注'],
      ['小王', 'a,"b"\nc'],
    ];
    expect(parseTable(toCsv(rows))).toEqual(rows);
  });
});
