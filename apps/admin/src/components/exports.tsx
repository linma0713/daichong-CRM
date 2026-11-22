import { useState } from 'react';
import { App, Button, Tooltip } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  CUSTOMER_SOURCES,
  CUSTOMER_STAGE_LABELS,
  FULFILLMENT_TYPE_LABELS,
  ORDER_KIND_LABELS,
  ORDER_STATUS_LABELS,
} from '@crm/shared';
import type { Schemas } from '../api/client';
import { cardText } from './business';
import { downloadCsv, yuan, type CsvCell } from './csv';

const time = (v: string | null | undefined) => (v ? dayjs(v).format('YYYY-MM-DD HH:mm') : '');
const SOURCE_LABELS: Record<string, string> = Object.fromEntries(
  CUSTOMER_SOURCES.map((s) => [s.value, s.label]),
);

/** 客户清单：前几列和导入模板一致，导出的表改完可以直接再导入（已有客户会被跳过） */
export function customerCsv(items: Schemas['CustomerDto'][]): CsvCell[][] {
  return [
    [
      '编号',
      '称呼',
      '微信',
      'Telegram',
      '手机',
      '邮箱',
      '来源',
      '渠道',
      '标签',
      '备注',
      '负责人',
      '阶段',
      'VIP',
      '代理',
      '累计实收（元）',
      '付费订单数',
      '服务到期',
      '最近联系',
      '建档时间',
    ],
    ...items.map((c) => [
      c.code,
      c.name,
      c.wechat,
      c.telegram,
      c.phone,
      c.email,
      SOURCE_LABELS[c.source] ?? c.source,
      c.channel?.name,
      c.tags.join('、'),
      c.remark,
      c.owner.displayName,
      CUSTOMER_STAGE_LABELS[c.stage],
      c.vip ? '是' : '',
      c.agent ? `${c.agent.name}（${c.agent.code}）` : '',
      yuan(c.netPaidCents),
      c.paidOrderCount,
      time(c.serviceEndAt),
      time(c.lastContactAt),
      time(c.createdAt),
    ]),
  ];
}

export function orderCsv(items: Schemas['OrderListItemDto'][]): CsvCell[][] {
  const margin = items.some((o) => o.marginCents !== null);
  return [
    [
      '订单号',
      '类型',
      '状态',
      '客户',
      '客户编号',
      '商品',
      '套餐',
      '时长（月）',
      '履约方式',
      '账号邮箱',
      '原价（元）',
      '优惠（元）',
      '质保（元）',
      '应收（元）',
      '已收（元）',
      '已退（元）',
      ...(margin ? ['毛利（元）'] : []),
      '负责人',
      '代理',
      '付款卡（尾号 持卡人）',
      '下单时间',
      '收款时间',
      '完成时间',
      '取消原因',
      '备注',
    ],
    ...items.map((o) => [
      o.code,
      ORDER_KIND_LABELS[o.kind],
      ORDER_STATUS_LABELS[o.status],
      o.customer.name,
      o.customer.code,
      o.productName,
      o.planName,
      o.termMonths,
      FULFILLMENT_TYPE_LABELS[o.fulfillmentType],
      o.accountEmail,
      yuan(o.listPriceCents),
      yuan(o.discountCents),
      o.withWarranty ? yuan(o.warrantyCents) : '',
      yuan(o.amountCents),
      yuan(o.paidCents),
      yuan(o.refundedCents),
      ...(margin ? [o.marginCents === null ? '' : yuan(o.marginCents)] : []),
      o.owner?.displayName,
      o.agent ? `${o.agent.name}（${o.agent.code}）` : '',
      o.paymentCards.map(cardText).join('；'),
      time(o.createdAt),
      time(o.paidAt),
      time(o.completedAt),
      o.cancelReason,
      o.remark,
    ]),
  ];
}

interface ExportResult<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

/** 「导出」按钮：按当前筛选拉全量（最多 5000 条），生成 CSV 下载。服务端会记日志 */
export function ExportButton<T>({
  name,
  fetch,
  toRows,
  tip,
}: {
  /** 文件名前缀，用英文 */
  name: string;
  fetch: () => Promise<ExportResult<T>>;
  toRows: (items: T[]) => CsvCell[][];
  tip: string;
}) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await fetch();
      if (r.items.length === 0) {
        message.info('当前筛选下没有数据');
        return;
      }
      downloadCsv(`${name}_${dayjs().format('YYYYMMDD-HHmm')}.csv`, toRows(r.items));
      if (r.truncated) {
        message.warning(
          `共 ${r.total} 条，只导出了前 ${r.items.length} 条，请加筛选条件分批导出`,
          6,
        );
      } else message.success(`已导出 ${r.items.length} 条`);
    } catch {
      // 错误提示由全局统一弹出
    } finally {
      setBusy(false);
    }
  };
  return (
    <Tooltip title={tip}>
      <Button icon={<DownloadOutlined />} loading={busy} onClick={() => void run()}>
        导出
      </Button>
    </Tooltip>
  );
}
