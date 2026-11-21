export type CsvCell = string | number | null | undefined;

/** 公式注入：以这些字符开头的文字在 Excel 里会被当成公式 */
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let text = FORMULA_START.test(value) ? `'${value}` : value;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** 生成 CSV 文本，带 BOM，Excel 直接打开不乱码 */
export function toCsv(rows: CsvCell[][]): string {
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n');
}

/** 金额（分）→ 元，导出用数字，方便在表格里再计算 */
export const yuan = (cents: number): number => Math.round(cents) / 100;

/** 文件名用英文：部分浏览器会把中文文件名换成「download」 */
export function downloadCsv(filename: string, rows: CsvCell[][]): void {
  const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * 解析 CSV / 从 Excel 复制出来的制表符文本，返回二维文字表。
 * 分隔符看第一行：有制表符就按制表符，否则按逗号。支持引号包起来的逗号、换行和 "" 转义。
 * 一条记录算一行（引号里的换行不算新行），空行保留。
 */
export function parseTable(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const sep = firstLine.includes('\t') ? '\t' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"' && cur === '') {
      quoted = true;
    } else if (ch === sep) {
      row.push(cur);
      cur = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
    } else cur += ch;
  }
  if (cur !== '' || row.length) {
    row.push(cur);
    rows.push(row);
  }
  // 空行原样保留，行号才能和 Excel 里看到的对上
  return rows;
}
