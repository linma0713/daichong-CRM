import dayjs from 'dayjs';
import { CUSTOMER_SOURCES } from '@crm/shared';
import type { Schemas } from '../../api/client';

export type ImportRow = Schemas['ImportCustomerRowDto'];
export type ImportField = Exclude<keyof ImportRow, 'line'>;

/** 导入表格的列：模板表头 + 常见的其他叫法（不分大小写，括号里的说明会忽略） */
export const IMPORT_COLUMNS: {
  field: ImportField;
  title: string;
  aliases: string[];
  note: string;
}[] = [
  {
    field: 'name',
    title: '称呼',
    aliases: ['客户', '客户称呼', '客户名称', '姓名', '名称', '名字', '昵称', 'name'],
    note: '必填，32 字以内',
  },
  {
    field: 'wechat',
    title: '微信',
    aliases: ['微信号', 'wechat', 'wx'],
    note: '四种联系方式至少填一个',
  },
  { field: 'telegram', title: 'Telegram', aliases: ['tg', '电报', '飞机'], note: '' },
  {
    field: 'phone',
    title: '手机',
    aliases: ['手机号', '手机号码', '电话', '联系电话', 'phone', 'mobile'],
    note: '',
  },
  {
    field: 'email',
    title: '邮箱',
    aliases: ['电子邮箱', '邮件', 'email', 'e-mail', 'mail'],
    note: '',
  },
  {
    field: 'source',
    title: '来源',
    aliases: ['客户来源', 'source'],
    note: `${CUSTOMER_SOURCES.map((s) => s.label).join(' / ')}，不填为自然流量`,
  },
  {
    field: 'channel',
    title: '渠道',
    aliases: ['获客渠道', '渠道名称', 'channel'],
    note: '填「渠道与营销」里已有的渠道名',
  },
  {
    field: 'tags',
    title: '标签',
    aliases: ['tags', 'tag'],
    note: '多个用逗号或顿号隔开，最多 10 个',
  },
  { field: 'remark', title: '备注', aliases: ['说明', 'remark', 'note'], note: '500 字以内' },
  {
    field: 'owner',
    title: '负责人',
    aliases: ['跟进人', '归属', '客服', '归属客服', 'owner'],
    note: '员工姓名或登录名，不填为你自己',
  },
];

const FIELD_BY_HEADER = new Map<string, ImportField>(
  IMPORT_COLUMNS.flatMap((c) => [c.title, ...c.aliases].map((h) => [normalizeHeader(h), c.field])),
);

/** 表头归一：去掉括号里的说明、必填星号、空白和冒号，转小写 */
export function normalizeHeader(h: string): string {
  return h
    .replace(/[（(【[].*$/, '')
    .replace(/[\s*＊:：]/g, '')
    .toLowerCase();
}

/** Excel 单元格 → 文字：日期写成年月日，数字原样 */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return dayjs(v).format('YYYY-MM-DD');
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v).trim();
}

/** 本系统导出的 CSV 为防公式在 = + - @ 开头的文字前加了单引号，导回来时去掉 */
const unescapeFormula = (s: string) => (/^'[=+\-@]/.test(s) ? s.slice(1) : s);

export interface MappedTable {
  rows: ImportRow[];
  /** 识别出的列（按表格顺序） */
  matched: string[];
  /** 不认识、会忽略的列 */
  ignored: string[];
  error?: string;
}

/**
 * 第一行当表头，按表头把每一行转成导入接口要的字段；空行跳过。
 * 每行带上它在表格里的行号（表头是第 1 行），服务端的提示用这个行号。
 */
export function mapTable(table: unknown[][]): MappedTable {
  const headerIndex = table.findIndex((r) => r.some((c) => cellText(c) !== ''));
  if (headerIndex < 0) return { rows: [], matched: [], ignored: [], error: '表格是空的' };
  const header = table[headerIndex].map(cellText);
  const fields: (ImportField | null)[] = [];
  const matched: string[] = [];
  const ignored: string[] = [];
  for (const h of header) {
    const f = FIELD_BY_HEADER.get(normalizeHeader(h)) ?? null;
    if (f && !fields.includes(f)) {
      fields.push(f);
      matched.push(h);
    } else {
      fields.push(null);
      if (h) ignored.push(h);
    }
  }
  if (!fields.includes('name')) {
    return {
      rows: [],
      matched,
      ignored,
      error: '没找到「称呼」列。第一行要是表头，可以下载模板对照',
    };
  }
  const rows: ImportRow[] = [];
  table.slice(headerIndex + 1).forEach((r, i) => {
    const row: ImportRow = { line: headerIndex + i + 2 };
    let filled = false;
    fields.forEach((f, col) => {
      if (!f) return;
      const v = unescapeFormula(cellText(r[col]));
      if (v) {
        row[f] = v;
        filled = true;
      }
    });
    if (filled) rows.push(row);
  });
  if (rows.length === 0) return { rows, matched, ignored, error: '表头下面没有数据' };
  return { rows, matched, ignored };
}
