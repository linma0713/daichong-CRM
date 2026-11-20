import { useState } from 'react';
import {
  Card,
  Col,
  Empty,
  Row,
  Segmented,
  Skeleton,
  Space,
  Statistic,
  Table,
  Tabs,
  Typography,
  type TableColumnsType,
} from 'antd';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { TICKET_TYPE_LABELS, formatCents, type TicketType } from '@crm/shared';
import { api, unwrap, type Schemas } from '../../api/client';
import { CustomerLink } from '../../components/business';
import { BarList, ColumnChart, LineChart, MeterList } from '../../components/charts';
import { formatYuanTick } from '../../components/chart-scale';
import { formatTime } from '../../components/format';

type Data = Schemas['AnalyticsDto'];
type Trend = Schemas['TrendDayDto'];
type View = 'chart' | 'table';

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`;
const mins = (v: number | null | undefined) => {
  if (v === null || v === undefined) return '—';
  if (v < 60) return `${Math.round(v)} 分钟`;
  return `${(v / 60).toFixed(1)} 小时`;
};
const hours = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${v.toFixed(1)} 小时`;
const cents = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : formatCents(Math.round(v));
const shortDate = (d: string) => d.slice(5);

function Tile({ title, value, hint }: { title: string; value: string | number; hint?: string }) {
  return (
    <Card size="small" style={{ height: '100%' }}>
      <Statistic title={title} value={value} />
      {hint && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {hint}
        </Typography.Text>
      )}
    </Card>
  );
}

function ViewSwitch({ value, onChange }: { value: View; onChange: (v: View) => void }) {
  return (
    <Segmented
      size="small"
      value={value}
      onChange={(v) => onChange(v as View)}
      options={[
        { value: 'chart', label: '图表' },
        { value: 'table', label: '表格' },
      ]}
    />
  );
}

const tile = { xs: 12, md: 8, xl: 6, xxl: 3 } as const;

export function AnalyticsPage() {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [moneyView, setMoneyView] = useState<View>('chart');
  const [countView, setCountView] = useState<View>('chart');
  const q = useQuery({
    queryKey: ['analytics', days],
    queryFn: () => unwrap(api.GET('/api/analytics', { params: { query: { days } } })),
    placeholderData: keepPreviousData,
  });
  const d = q.data;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card
        title="数据看板"
        extra={
          <Segmented
            value={days}
            onChange={(v) => setDays(v as 7 | 30 | 90)}
            options={[
              { value: 7, label: '近 7 天' },
              { value: 30, label: '近 30 天' },
              { value: 90, label: '近 90 天' },
            ]}
          />
        }
      >
        {d ? (
          <div style={{ opacity: q.isFetching ? 0.6 : 1, transition: 'opacity .2s' }}>
            <Typography.Paragraph type="secondary">
              {d.from} 至 {d.to}（北京时间）。客户价值按全部历史计算，不受区间影响。
            </Typography.Paragraph>
            <Overview d={d} />
          </div>
        ) : (
          <Skeleton active loading={q.isLoading} />
        )}
      </Card>

      {d && (
        <div style={{ opacity: q.isFetching ? 0.6 : 1, transition: 'opacity .2s' }}>
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Card
              size="small"
              title="每日收款"
              extra={<ViewSwitch value={moneyView} onChange={setMoneyView} />}
            >
              {moneyView === 'chart' ? (
                <ColumnChart
                  ariaLabel="每日收款柱状图"
                  formatTick={formatYuanTick}
                  data={d.trend.map((t) => ({
                    key: t.date,
                    label: shortDate(t.date),
                    value: t.receivedCents,
                    tooltip: [
                      { label: '收款', value: formatCents(t.receivedCents) },
                      { label: '退款', value: formatCents(t.refundedCents) },
                      { label: '收齐款订单', value: `${t.paidOrders} 单` },
                    ],
                  }))}
                />
              ) : (
                <TrendTable trend={d.trend} />
              )}
            </Card>

            <Card
              size="small"
              title="订单、新客户与售后工单（每日）"
              extra={<ViewSwitch value={countView} onChange={setCountView} />}
            >
              {countView === 'chart' ? (
                <LineChart
                  ariaLabel="每日订单、新客户、售后工单折线图"
                  labels={d.trend.map((t) => shortDate(t.date))}
                  series={[
                    {
                      key: 'orders',
                      label: '收齐款订单',
                      values: d.trend.map((t) => t.paidOrders),
                    },
                    {
                      key: 'customers',
                      label: '新客户',
                      values: d.trend.map((t) => t.newCustomers),
                    },
                    { key: 'tickets', label: '售后工单', values: d.trend.map((t) => t.tickets) },
                  ]}
                />
              ) : (
                <TrendTable trend={d.trend} />
              )}
            </Card>

            <Row gutter={[16, 16]}>
              <Col xs={24} lg={12}>
                <Card size="small" title="续费率（按套餐）" style={{ height: '100%' }}>
                  <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                    服务期在区间内结束的订单里，之后下了续费单的比例（已退款终止的不算）。
                  </Typography.Paragraph>
                  {d.renewal.byPlan.length ? (
                    <MeterList
                      rows={d.renewal.byPlan.map((p) => ({
                        key: p.key,
                        label: p.label,
                        ratio: p.rate,
                        figure: pct(p.rate),
                        hint: `${p.renewed}/${p.due}`,
                      }))}
                    />
                  ) : (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="区间内没有到期的订单"
                    />
                  )}
                </Card>
              </Col>
              <Col xs={24} lg={12}>
                <Card size="small" title="售后问题类型" style={{ height: '100%' }}>
                  {d.aftersales.tickets ? (
                    <BarList
                      format={(v) => `${v} 个`}
                      rows={d.aftersales.byType.map((t) => ({
                        key: t.type,
                        label: TICKET_TYPE_LABELS[t.type as TicketType] ?? t.type,
                        value: t.count,
                      }))}
                    />
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="区间内没有售后工单" />
                  )}
                </Card>
              </Col>
            </Row>

            <StaffCard staff={d.staff} />
            <LtvCard ltv={d.ltv} />
          </Space>
        </div>
      )}
    </Space>
  );
}

function Overview({ d }: { d: Data }) {
  const received = d.trend.reduce((n, t) => n + t.receivedCents, 0);
  const orders = d.trend.reduce((n, t) => n + t.paidOrders, 0);
  const renewals = d.trend.reduce((n, t) => n + t.renewalOrders, 0);
  const customers = d.trend.reduce((n, t) => n + t.newCustomers, 0);
  return (
    <Row gutter={[12, 12]}>
      <Col {...tile}>
        <Tile
          title="收款"
          value={formatCents(received)}
          hint={`退款 ${formatCents(d.aftersales.refundedCents)}`}
        />
      </Col>
      <Col {...tile}>
        <Tile title="收齐款订单" value={orders} hint={`其中续费 ${renewals} 单`} />
      </Col>
      <Col {...tile}>
        <Tile title="新客户" value={customers} />
      </Col>
      <Col {...tile}>
        <Tile
          title="续费率"
          value={pct(d.renewal.rate)}
          hint={`${d.renewal.renewed}/${d.renewal.due} 个到期订单已续费`}
        />
      </Col>
      <Col {...tile}>
        <Tile
          title="开通按时率"
          value={pct(d.activation.onTimeRate)}
          hint={`${d.activation.done} 单，中位用时 ${mins(d.activation.medianMinutes)}`}
        />
      </Col>
      <Col {...tile}>
        <Tile
          title="售后率"
          value={pct(d.aftersales.ticketRate)}
          hint={`${d.aftersales.subscriptionsWithTickets}/${d.aftersales.activeSubscriptions} 个在服务订阅出过工单`}
        />
      </Col>
      <Col {...tile}>
        <Tile
          title="按时解决率"
          value={pct(d.aftersales.onTimeRate)}
          hint={`解决 ${d.aftersales.resolved} 个，平均 ${hours(d.aftersales.avgResolveHours)}`}
        />
      </Col>
      <Col {...tile}>
        <Tile title="退款率" value={pct(d.aftersales.refundRate)} hint="退款 ÷ 收款" />
      </Col>
    </Row>
  );
}

function TrendTable({ trend }: { trend: Trend[] }) {
  const columns: TableColumnsType<Trend> = [
    { title: '日期', dataIndex: 'date', key: 'date', width: 110 },
    { title: '收款', key: 'r', align: 'right', render: (_, t) => formatCents(t.receivedCents) },
    { title: '退款', key: 'f', align: 'right', render: (_, t) => formatCents(t.refundedCents) },
    { title: '收齐款订单', dataIndex: 'paidOrders', key: 'o', align: 'right' },
    { title: '其中续费', dataIndex: 'renewalOrders', key: 'rn', align: 'right' },
    { title: '新客户', dataIndex: 'newCustomers', key: 'c', align: 'right' },
    { title: '完成开通', dataIndex: 'activations', key: 'a', align: 'right' },
    { title: '售后工单', dataIndex: 'tickets', key: 't', align: 'right' },
  ];
  return (
    <Table<Trend>
      rowKey="date"
      size="small"
      columns={columns}
      dataSource={[...trend].reverse()}
      pagination={false}
      scroll={{ x: 760, y: 360 }}
    />
  );
}

function StaffCard({ staff }: { staff: Data['staff'] }) {
  const sales: TableColumnsType<Schemas['SalesPerfDto']> = [
    { title: '客服', dataIndex: 'name', key: 'name' },
    { title: '收齐款订单', dataIndex: 'paidOrders', key: 'o', align: 'right' },
    { title: '其中续费', dataIndex: 'renewalOrders', key: 'r', align: 'right' },
    { title: '实收', key: 'p', align: 'right', render: (_, s) => formatCents(s.paidCents) },
    { title: '毛利', key: 'm', align: 'right', render: (_, s) => cents(s.marginCents) },
    { title: '新客户', dataIndex: 'newCustomers', key: 'c', align: 'right' },
  ];
  const fulfillment: TableColumnsType<Schemas['FulfillmentPerfDto']> = [
    { title: '充值员', dataIndex: 'name', key: 'name' },
    { title: '完成任务', dataIndex: 'done', key: 'd', align: 'right' },
    { title: '按时率', key: 'o', align: 'right', render: (_, f) => pct(f.onTimeRate) },
    { title: '其中开通', dataIndex: 'activations', key: 'a', align: 'right' },
    {
      title: '开通平均用时',
      key: 'm',
      align: 'right',
      render: (_, f) => mins(f.avgActivationMinutes),
    },
  ];
  const aftersales: TableColumnsType<Schemas['AftersalesPerfDto']> = [
    { title: '售后', dataIndex: 'name', key: 'name' },
    { title: '解决工单', dataIndex: 'resolved', key: 'r', align: 'right' },
    { title: '平均解决用时', key: 'h', align: 'right', render: (_, a) => hours(a.avgHours) },
    { title: '被升级', dataIndex: 'escalated', key: 'e', align: 'right' },
  ];
  const table = <T extends { userId: string }>(columns: TableColumnsType<T>, rows: T[]) => (
    <Table<T>
      rowKey="userId"
      size="small"
      columns={columns}
      dataSource={rows}
      pagination={false}
      scroll={{ x: 560 }}
    />
  );
  return (
    <Card size="small" title="员工业绩" styles={{ body: { paddingTop: 0 } }}>
      <Tabs
        items={[
          { key: 'sales', label: '客服（按负责客户）', children: table(sales, staff.sales) },
          { key: 'fulfillment', label: '充值员', children: table(fulfillment, staff.fulfillment) },
          { key: 'aftersales', label: '售后', children: table(aftersales, staff.aftersales) },
        ]}
      />
    </Card>
  );
}

function LtvCard({ ltv }: { ltv: Data['ltv'] }) {
  const top: TableColumnsType<Schemas['LtvCustomerDto']> = [
    { title: '客户', key: 'c', render: (_, c) => <CustomerLink customer={c.customer} /> },
    { title: '订单', dataIndex: 'orders', key: 'o', align: 'right' },
    { title: '累计净收入', key: 'n', align: 'right', render: (_, c) => formatCents(c.netCents) },
    { title: '累计毛利', key: 'm', align: 'right', render: (_, c) => cents(c.marginCents) },
    { title: '首单', key: 'f', render: (_, c) => formatTime(c.firstPaidAt).slice(0, 10) },
    { title: '最近一单', key: 'l', render: (_, c) => formatTime(c.lastPaidAt).slice(0, 10) },
  ];
  const sources: TableColumnsType<Schemas['LtvSourceDto']> = [
    { title: '来源', dataIndex: 'label', key: 'l' },
    { title: '付费客户', dataIndex: 'customers', key: 'c', align: 'right' },
    { title: '平均净收入', key: 'n', align: 'right', render: (_, s) => formatCents(s.avgNetCents) },
  ];
  return (
    <Card size="small" title="客户价值（全部历史）">
      <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
        <Col {...tile}>
          <Tile title="付费客户" value={ltv.payingCustomers} />
        </Col>
        <Col {...tile}>
          <Tile
            title="复购率"
            value={pct(ltv.payingCustomers ? ltv.repeatCustomers / ltv.payingCustomers : null)}
            hint={`${ltv.repeatCustomers} 个客户买过 2 次及以上`}
          />
        </Col>
        <Col {...tile}>
          <Tile title="平均客户净收入" value={cents(ltv.avgNetCents)} hint="实收 − 退款" />
        </Col>
        <Col {...tile}>
          <Tile
            title="平均客户毛利"
            value={cents(ltv.avgMarginCents)}
            hint={ltv.avgOrders ? `平均 ${ltv.avgOrders.toFixed(1)} 单` : undefined}
          />
        </Col>
      </Row>
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={9}>
          <Typography.Text strong>按来源</Typography.Text>
          <Table
            rowKey="source"
            size="small"
            style={{ marginTop: 8 }}
            columns={sources}
            dataSource={ltv.bySource}
            pagination={false}
          />
        </Col>
        <Col xs={24} lg={15}>
          <Typography.Text strong>净收入最高的 10 个客户</Typography.Text>
          <Table
            rowKey={(c) => c.customer.id}
            size="small"
            style={{ marginTop: 8 }}
            columns={top}
            dataSource={ltv.top}
            pagination={false}
            scroll={{ x: 560 }}
          />
        </Col>
      </Row>
    </Card>
  );
}
