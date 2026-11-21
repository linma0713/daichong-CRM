import { describe, expect, it } from 'vitest';
import { cellText, mapTable, normalizeHeader } from './import';

describe('normalizeHeader', () => {
  it('去括号说明、星号、空格，转小写', () => {
    expect(normalizeHeader('称呼*')).toBe('称呼');
    expect(normalizeHeader('负责人（填姓名或登录名）')).toBe('负责人');
    expect(normalizeHeader(' E-mail ')).toBe('e-mail');
    expect(normalizeHeader('手机 (选填)')).toBe('手机');
  });
});

describe('cellText', () => {
  it('Excel 单元格转文字', () => {
    expect(cellText(null)).toBe('');
    expect(cellText('  小王 ')).toBe('小王');
    expect(cellText('13800138000')).toBe('13800138000');
    expect(cellText(new Date(2026, 10, 21))).toBe('2026-11-21');
    expect(cellText(true)).toBe('是');
  });
});

describe('mapTable', () => {
  it('按表头识别列，别名和英文都认，不认识的列忽略', () => {
    const r = mapTable([
      ['编号', '客户', '微信号', 'TG', '手机号', '标签', '阶段'],
      ['C0001', '王先生', 'wx_w', '', '13800138000', 'Pro,老客', '活跃'],
    ]);
    expect(r.error).toBeUndefined();
    expect(r.matched).toEqual(['客户', '微信号', 'TG', '手机号', '标签']);
    expect(r.ignored).toEqual(['编号', '阶段']);
    expect(r.rows).toEqual([
      { line: 2, name: '王先生', wechat: 'wx_w', phone: '13800138000', tags: 'Pro,老客' },
    ]);
  });

  it('跳过空行，行号和表格对得上（表头前有空行也算）', () => {
    const r = mapTable([[''], ['称呼', '微信'], ['甲', 'a'], ['', ''], ['乙', 'b']]);
    expect(r.rows.map((x) => [x.line, x.name])).toEqual([
      [3, '甲'],
      [5, '乙'],
    ]);
  });

  it('去掉导出时防公式加的单引号', () => {
    const r = mapTable([
      ['称呼', '手机'],
      ['丙', "'+8613800138000"],
    ]);
    expect(r.rows[0].phone).toBe('+8613800138000');
  });

  it('同一个字段出现两列只认第一列', () => {
    const r = mapTable([
      ['称呼', '姓名'],
      ['甲', '乙'],
    ]);
    expect(r.rows[0].name).toBe('甲');
    expect(r.ignored).toEqual(['姓名']);
  });

  it('没有称呼列或没有数据时给出提示', () => {
    expect(mapTable([['微信'], ['a']]).error).toContain('称呼');
    expect(mapTable([['称呼', '微信']]).error).toBe('表头下面没有数据');
    expect(mapTable([]).error).toBe('表格是空的');
  });
});
