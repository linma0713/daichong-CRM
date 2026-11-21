import { Link } from 'react-router';
import { Space, Table, Tag, Tooltip, Typography, type TableColumnsType } from 'antd';
import type { TablePaginationConfig } from 'antd';
import { COMMISSION_ROLE_LABELS, formatCents, formatRate } from '@crm/shared';
import type { Schemas } from '../../api/client';
import { AgentLink, CommissionStatusTag, CustomerLink } from '../../components/business';
import { formatTime } from '../../components/format';

type Commission = Schemas['CommissionDto'];

/** 佣金明细表：订单详情、代理详情、佣金页共用 */
export function CommissionTable({
  data,
  loading,
  pagination = false,
  hideOrder,
  hideAgent,
  emptyText = '还没有佣金',
}: {
  data?: Commission[];
  loading?: boolean;
  pagination?: false | TablePaginationConfig;
  hideOrder?: boolean;
  hideAgent?: boolean;
  emptyText?: string;
}) {
  const columns: TableColumnsType<Commission> = [
    ...(hideOrder
      ? []
      : [
          {
            title: '订单',
            key: 'order',
            render: (_: unknown, c: Commission) => (
              <Space direction="vertical" size={0}>
                <Link to={`/orders/${c.order.id}`}>{c.order.code}</Link>
                <span style={{ fontSize: 12 }}>
                  <CustomerLink customer={c.customer} />
                </span>
              </Space>
            ),
          },
        ]),
    ...(hideAgent
      ? []
      : [
          {
            title: '代理',
            key: 'agent',
            render: (_: unknown, c: Commission) => <AgentLink agent={c.agent} />,
          },
        ]),
    {
      title: '类型',
      key: 'kind',
      render: (_, c) => (
        <Space direction="vertical" size={0}>
          <span>
            {COMMISSION_ROLE_LABELS[c.role]}
            {c.kind === 'CLAWBACK' && (
              <Tag color="red" style={{ marginLeft: 6 }}>
                退款扣回
              </Tag>
            )}
          </span>
          {c.kind === 'ACCRUAL' && c.periods > 1 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              第 {c.seq} / {c.periods} 期（按服务月释放）
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: '比例 × 基数',
      key: 'rate',
      render: (_, c) =>
        c.kind === 'CLAWBACK' ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space direction="vertical" size={0}>
            <span>{formatRate(c.rateBp)}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              基数 {formatCents(c.baseCents)}
            </Typography.Text>
          </Space>
        ),
    },
    {
      title: '金额',
      key: 'amount',
      align: 'right',
      render: (_, c) => (
        <Space direction="vertical" size={0} style={{ alignItems: 'flex-end' }}>
          <Typography.Text
            strong
            delete={c.status === 'VOID'}
            type={c.amountCents < 0 ? 'danger' : undefined}
            style={{ whiteSpace: 'nowrap' }}
          >
            {formatCents(c.status === 'VOID' ? c.originalCents : c.amountCents)}
          </Typography.Text>
          {c.kind === 'ACCRUAL' && c.amountCents !== c.originalCents && c.status !== 'VOID' && (
            <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
              原 {formatCents(c.originalCents)}，退款扣减
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: '状态',
      key: 'status',
      render: (_, c) => (
        <Space direction="vertical" size={0}>
          <CommissionStatusTag status={c.status} />
          {c.refund && (
            <Tooltip title="因为这笔退款扣减或扣回">
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                退款 {c.refund.code}
              </Typography.Text>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      title: '解冻时间',
      key: 'releaseAt',
      render: (_, c) =>
        c.status === 'FROZEN' ? (
          <Tooltip title="到这个时间自动变成可结算（每小时巡检一次）">
            {formatTime(c.releaseAt)}
          </Tooltip>
        ) : (
          <Typography.Text type="secondary">
            {c.releasedAt ? formatTime(c.releasedAt) : '—'}
          </Typography.Text>
        ),
    },
  ];
  return (
    <Table<Commission>
      rowKey="id"
      size="small"
      columns={columns}
      dataSource={data}
      loading={loading}
      pagination={pagination}
      scroll={{ x: 760 }}
      locale={{ emptyText }}
    />
  );
}
