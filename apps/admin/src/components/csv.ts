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
