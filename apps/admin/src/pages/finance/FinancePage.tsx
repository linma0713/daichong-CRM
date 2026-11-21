import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Row,
  Segmented,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Typography,
  type TableColumnsType,
} from 'antd';
import { DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { Dayjs } from 'dayjs';
import { formatCents } from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { CustomerLink } from '../../components/business';
import { downloadCsv, yuan } from '../../components/csv';
import { beijingToday, formatTime } from '../../components/format';

type Report = Schemas['FinanceReportDto'];
type Day = Schemas['FinanceDayDto'];
type Method = Schemas['FinanceMethodDto'];
type Group = Schemas['FinanceGroupDto'];
type Entry = Schemas['JournalEntryDto'];
type Range = [Dayjs, Dayjs];

const KEY = 'YYYY-MM-DD';
function presets(): { label: string; value: Range }[] {
  const today = beijingToday();
  const lastMonth = today.subtract(1, 'month');
  return [
    { label: '今天', value: [today, today] },
    { label: '昨天', value: [today.subtract(1, 'day'), today.subtract(1, 'day')] },
    { label: '本周', value: [today.startOf('week'), today] },
    { label: '本月', value: [today.startOf('month'), today] },
    { label: '上月', value: [lastMonth.startOf('month'), lastMonth.endOf('month').startOf('day')] },
    { label: '近 30 天', value: [today.subtract(29, 'day'), today] },
  ];
}

const KIND_META: Record<Entry['kind'], { label: string; color: string }> = {
  payment: { label: '收款', color: 'green' },
  refund: { label: '退款', color: 'red' },
  cost: { label: '成本', color: 'orange' },
  commission: { label: '代理佣金', color: 'purple' },
};

const money = (cents: number, opts: { danger?: boolean; strong?: boolean } = {}) => (
  <Typography.Text
    strong={opts.strong}
    type={opts.danger && cents < 0 ? 'danger' : undefined}
    style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}
  >
    {formatCents(cents)}
  </Typography.Text>
);
const rate = (part: number, whole: number) =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—';

const AMOUNT_TITLES = ['收款', '退款', '手续费', '净收入', '成本', '代理佣金', '毛利'];

function withCount(cents: number, count: number) {
  return (
    <Space direction="vertical" size={0} style={{ alignItems: 'flex-end' }}>
      {money(cents)}
      {count > 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {count} 笔
        </Typography.Text>
      )}
    </Space>
  );
}

/** 每日对账一行的金额格，顺序同 AMOUNT_TITLES；合计行复用 */
function amountCells(d: Omit<Day, 'date'>): ReactNode[] {
  return [
    withCount(d.receivedCents, d.paymentCount),
    withCount(d.refundedCents, d.refundCount),
    money(d.feeCents),
    money(d.netCents, { danger: true, strong: true }),
    money(d.costCents),
    money(d.commissionCents),
    money(d.profitCents, { danger: true, strong: true }),
  ];
}

function StatTile({
  title,
  cents,
  hint,
  danger,
}: {
  title: string;
  cents: number;
  hint?: string;
  danger?: boolean;
}) {
  return (
    <Card size="small" style={{ height: '100%' }}>
      <Statistic
        title={title}
        value={formatCents(cents)}
        valueStyle={danger && cents < 0 ? { color: '#cf1322' } : undefined}
      />
      {hint && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {hint}
        </Typography.Text>
      )}
    </Card>
  );
}

export function FinancePage() {
  const [range, setRange] = useState<Range>(() => presets()[3].value);
  const [tab, setTab] = useState('days');
  const [kind, setKind] = useState<'all' | Entry['kind']>('all');
  const query = { from: range[0].format(KEY), to: range[1].format(KEY) };
  const report = useQuery({
    queryKey: ['finance', 'report', query],
    queryFn: () => unwrap(api.GET('/api/finance/report', { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const journal = useQuery({
    queryKey: ['finance', 'journal', query],
    queryFn: () => unwrap(api.GET('/api/finance/journal', { params: { query } })),
    placeholderData: keepPreviousData,
    enabled: tab === 'journal',
  });
  const r = report.data;
  const t = r?.totals;
  const entries = useMemo(
    () => (journal.data?.items ?? []).filter((e) => kind === 'all' || e.kind === kind),
    [journal.data, kind],
  );
  const suffix = `${query.from}_${query.to}`;

  const dayColumns: TableColumnsType<Day> = [
    { title: '日期', dataIndex: 'date', key: 'date', width: 120 },
    ...AMOUNT_TITLES.map((title, i) => ({
      title,
      key: title,
      align: 'right' as const,
      render: (_: unknown, d: Day) => amountCells(d)[i],
    })),
  ];

  const methodColumns: TableColumnsType<Method> = [
    { title: '方式', dataIndex: 'label', key: 'label', width: 120 },
    { title: '收款笔数', dataIndex: 'paymentCount', key: 'pc', align: 'right' },
    { title: '收款', key: 'rc', align: 'right', render: (_, m) => money(m.receivedCents) },
    { title: '手续费', key: 'fee', align: 'right', render: (_, m) => money(m.feeCents) },
    { title: '退款笔数', dataIndex: 'refundCount', key: 'fc', align: 'right' },
    { title: '退款', key: 'rf', align: 'right', render: (_, m) => money(m.refundedCents) },
    {
      title: '到账净额',
      key: 'net',
      align: 'right',
      render: (_, m) => money(m.netCents, { danger: true, strong: true }),
    },
  ];

  const groupColumns = (title: string): TableColumnsType<Group> => [
    { title, dataIndex: 'label', key: 'label' },
    { title: '订单数', dataIndex: 'orderCount', key: 'n', align: 'right' },
    { title: '实收', key: 'paid', align: 'right', render: (_, g) => money(g.paidCents) },
    { title: '退款', key: 'refunded', align: 'right', render: (_, g) => money(g.refundedCents) },
    { title: '手续费', key: 'fee', align: 'right', render: (_, g) => money(g.feeCents) },
    { title: '成本', key: 'cost', align: 'right', render: (_, g) => money(g.costCents) },
    {
      title: '代理佣金',
      key: 'commission',
      align: 'right',
      render: (_, g) => money(g.commissionCents),
    },
    {
      title: '毛利',
      key: 'margin',
      align: 'right',
      render: (_, g) => money(g.marginCents, { danger: true, strong: true }),
    },
    {
      title: '毛利率',
      key: 'rate',
      align: 'right',
      render: (_, g) => rate(g.marginCents, g.paidCents - g.refundedCents),
    },
  ];

  const journalColumns: TableColumnsType<Entry> = [
    { title: '时间', key: 'at', width: 150, render: (_, e) => formatTime(e.at) },
    {
      title: '类型',
      key: 'kind',
      width: 90,
      render: (_, e) => <Tag color={KIND_META[e.kind].color}>{KIND_META[e.kind].label}</Tag>,
    },
    { title: '方式 / 类别', dataIndex: 'category', key: 'category', width: 110 },
    {
      title: '金额',
      key: 'amount',
      align: 'right',
      width: 120,
      render: (_, e) => money(e.amountCents, { danger: true }),
    },
    {
      title: '手续费',
      key: 'fee',
      align: 'right',
      width: 90,
      render: (_, e) => (e.feeCents ? money(e.feeCents) : '—'),
    },
    {
      title: '订单',
      key: 'order',
      width: 100,
      render: (_, e) =>
        e.kind === 'commission' ? (
          <Link to={`/commissions/statements/${e.id}`}>对账单</Link>
        ) : e.orderId ? (
          <Link to={`/orders/${e.orderId}`}>{e.orderCode}</Link>
        ) : (
          '—'
        ),
    },
    {
      title: '客户',
      key: 'customer',
      width: 140,
      render: (_, e) => (e.customer ? <CustomerLink customer={e.customer} /> : '—'),
    },
    { title: '单号 / 说明', dataIndex: 'reference', key: 'ref', render: (v) => v ?? '—' },
    { title: '经手人', dataIndex: 'userName', key: 'user', width: 100 },
  ];

  function exportDays(report: Report) {
    const head = [
      '日期',
      '收款笔数',
      '收款',
      '退款笔数',
      '退款',
      '手续费',
      '净收入',
      '成本',
      '代理佣金',
      '毛利',
    ];
    const line = (label: string, d: Day | Report['totals']) => [
      label,
      d.paymentCount,
      yuan(d.receivedCents),
      d.refundCount,
      yuan(d.refundedCents),
      yuan(d.feeCents),
      yuan(d.netCents),
      yuan(d.costCents),
      yuan(d.commissionCents),
      yuan(d.profitCents),
    ];
    downloadCsv(`finance-daily_${suffix}.csv`, [
      head,
      ...report.days.map((d) => line(d.date, d)),
      line('合计', report.totals),
    ]);
  }

  function exportJournal() {
    downloadCsv(`finance-journal_${suffix}.csv`, [
      ['时间', '类型', '方式 / 类别', '金额', '手续费', '订单', '客户', '单号 / 说明', '经手人'],
      ...entries.map((e) => [
        formatTime(e.at),
        KIND_META[e.kind].label,
        e.category,
        yuan(e.amountCents),
        yuan(e.feeCents),
        e.orderCode,
        e.customer ? `${e.customer.name}（${e.customer.code}）` : null,
        e.reference,
        e.userName,
      ]),
    ]);
  }

  const summaryRow = (cells: ReactNode[]) => (
    <Table.Summary fixed>
      <Table.Summary.Row>
        {cells.map((c, i) => (
          <Table.Summary.Cell key={i} index={i} align={i === 0 ? 'left' : 'right'}>
            {i === 0 ? <Typography.Text strong>{c}</Typography.Text> : c}
          </Table.Summary.Cell>
        ))}
      </Table.Summary.Row>
    </Table.Summary>
  );

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card title="财务对账">
        <div className="page-toolbar">
          <div className="page-toolbar-filters">
            <DatePicker.RangePicker
              value={range}
              allowClear={false}
              presets={presets()}
              disabledDate={(d) => d.isAfter(beijingToday(), 'day')}
              onChange={(v) => v?.[0] && v[1] && setRange([v[0], v[1]])}
            />
            <Typography.Text type="secondary">按北京时间的日期统计，含首尾两天</Typography.Text>
          </div>
          <Space>
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                void report.refetch();
                if (tab === 'journal') void journal.refetch();
              }}
            >
              刷新
            </Button>
            <Button icon={<DownloadOutlined />} disabled={!r} onClick={() => r && exportDays(r)}>
              导出每日对账
            </Button>
          </Space>
        </div>
        <div style={{ opacity: report.isFetching && r ? 0.6 : 1, transition: 'opacity .2s' }}>
          <Row gutter={[12, 12]}>
            <Col xs={12} md={6} xl={{ flex: '1 1 0' }}>
              <StatTile
                title="收款"
                cents={t?.receivedCents ?? 0}
                hint={t ? `${t.paymentCount} 笔` : undefined}
              />
            </Col>
            <Col xs={12} md={6} xl={{ flex: '1 1 0' }}>
              <StatTile
                title="退款出账"
                cents={t?.refundedCents ?? 0}
                hint={t ? `${t.refundCount} 笔` : undefined}
              />
            </Col>
            <Col xs={12} md={6} xl={{ flex: '1 1 0' }}>
              <StatTile title="收款手续费" cents={t?.feeCents ?? 0} />
            </Col>
            <Col xs={12} md={6} xl={{ flex: '1 1 0' }}>
              <StatTile
                title="净收入"
                cents={t?.netCents ?? 0}
                danger
                hint="收款 − 退款 − 手续费"
              />
            </Col>
            <Col xs={12} md={6} xl={{ flex: '1 1 0' }}>
              <StatTile title="成本" cents={t?.costCents ?? 0} hint="上游扣费、成品号等" />
            </Col>
            <Col xs={12} md={6} xl={{ flex: '1 1 0' }}>
              <StatTile title="代理佣金" cents={t?.commissionCents ?? 0} hint="对账单结清时计入" />
            </Col>
            <Col xs={12} md={6} xl={{ flex: '1 1 0' }}>
              <StatTile
                title="毛利"
                cents={t?.profitCents ?? 0}
                danger
                hint={
                  t ? `毛利率 ${rate(t.profitCents, t.receivedCents - t.refundedCents)}` : undefined
                }
              />
            </Col>
          </Row>
          {t?.resourceSpendCents !== null && t?.resourceSpendCents !== undefined && (
            <Alert
              type="info"
              showIcon
              style={{ marginTop: 12 }}
              message={`同期付款资源入库支出 ${formatCents(t.resourceSpendCents)}`}
              description="买卡、礼品卡、充值余额的实际花费。这笔钱先进库存，用掉的部分才按平均成本计入上面的「成本」。"
            />
          )}
        </div>
      </Card>

      <Card size="small" styles={{ body: { paddingTop: 0 } }}>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: 'days',
              label: '每日对账',
              children: (
                <Table<Day>
                  rowKey="date"
                  size="small"
                  columns={dayColumns}
                  dataSource={r?.days}
                  loading={report.isLoading}
                  pagination={false}
                  scroll={{ x: 800, y: 520 }}
                  summary={() => t && summaryRow(['合计', ...amountCells(t)])}
                />
              ),
            },
            {
              key: 'methods',
              label: '收款方式',
              children: (
                <>
                  <Typography.Paragraph type="secondary">
                    和微信、支付宝等账单逐项核对：到账净额 = 收款 − 手续费 − 从这个渠道退出去的钱。
                    「代理代收」的钱在代理手里，不进我们的账户，月底在佣金对账单里抵扣。
                  </Typography.Paragraph>
                  <Table<Method>
                    rowKey="method"
                    size="small"
                    columns={methodColumns}
                    dataSource={r?.methods}
                    loading={report.isLoading}
                    pagination={false}
                    scroll={{ x: 700 }}
                  />
                </>
              ),
            },
            ...(
              [
                ['product', '按商品', '商品', r?.byProduct],
                ['staff', '按客服', '负责客服', r?.byStaff],
                ['source', '按来源', '客户来源', r?.bySource],
                ['agent', '按代理', '代理', r?.byAgent],
              ] as const
            ).map(([key, label, title, rows]) => ({
              key,
              label,
              children: (
                <>
                  <Typography.Paragraph type="secondary">
                    按区间内收齐款的订单统计；退款和成本是这些订单截至目前的累计，所以和上面的现金口径会有差别。
                  </Typography.Paragraph>
                  <Table<Group>
                    rowKey="key"
                    size="small"
                    columns={groupColumns(title)}
                    dataSource={rows ? [...rows] : undefined}
                    loading={report.isLoading}
                    pagination={false}
                    scroll={{ x: 800 }}
                  />
                </>
              ),
            })),
            {
              key: 'journal',
              label: '收支明细',
              children: (
                <>
                  <div className="page-toolbar">
                    <Segmented
                      value={kind}
                      onChange={(v) => setKind(v as typeof kind)}
                      options={[
                        { value: 'all', label: '全部' },
                        { value: 'payment', label: '收款' },
                        { value: 'refund', label: '退款' },
                        { value: 'cost', label: '成本' },
                        { value: 'commission', label: '代理佣金' },
                      ]}
                    />
                    <Button
                      icon={<DownloadOutlined />}
                      disabled={!journal.data}
                      onClick={exportJournal}
                    >
                      导出明细
                    </Button>
                  </div>
                  {journal.data?.truncated && (
                    <Alert
                      type="warning"
                      showIcon
                      style={{ marginBottom: 12 }}
                      message="明细太多，只显示了前 5000 条，请缩小日期范围"
                    />
                  )}
                  <Table<Entry>
                    rowKey={(e) => `${e.kind}-${e.id}`}
                    size="small"
                    columns={journalColumns}
                    dataSource={entries}
                    loading={journal.isFetching}
                    scroll={{ x: 1100 }}
                    pagination={{
                      defaultPageSize: 50,
                      showSizeChanger: true,
                      showTotal: (n: number) => `共 ${n} 条`,
                    }}
                  />
                </>
              ),
            },
          ]}
        />
      </Card>
    </Space>
  );
}
