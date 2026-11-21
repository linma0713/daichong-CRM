import { useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  Button,
  Card,
  Col,
  Input,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Typography,
  type TableColumnsType,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  COMMISSION_ROLE_LABELS,
  COMMISSION_STATUS_LABELS,
  COMMISSION_STATUSES,
  formatCents,
  type CommissionRole,
  type CommissionStatus,
} from '@crm/shared';
import { api, unwrap, type QueryOf, type Schemas } from '../../api/client';
import { useBusinessSettings } from '../../api/queries';
import { AgentLink, AgentSelect, Money } from '../../components/business';
import { CommissionTable } from './CommissionTable';
import { StatementsTab } from './StatementsTab';

type Summary = Schemas['AgentCommissionSummaryDto'];
type Filters = QueryOf<'/api/commissions'> & { page: number; pageSize: number };

export function CommissionsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'summary';
  const agentId = params.get('agentId') ?? undefined;
  const settings = useBusinessSettings();

  const openDetails = (id: string) => setParams({ tab: 'list', agentId: id });

  return (
    <Card title="佣金结算">
      <Typography.Paragraph type="secondary">
        订单完成时按下单时的比例计提佣金。没加购质保的冻结{' '}
        {settings.data?.commissionFreezeDays ?? 7}{' '}
        天，加购质保的按服务月逐月释放；冻结期内退款直接扣减或作废，已对账后退款记「退款扣回」，下次对账时抵扣。
        每月 1 号自动给上个月出对账单，佣金减去代理代收的款，多退少补。
      </Typography.Paragraph>
      <Tabs
        activeKey={tab}
        onChange={(key) =>
          setParams(key === 'list' && agentId ? { tab: key, agentId } : { tab: key })
        }
        items={[
          {
            key: 'summary',
            label: '按代理汇总',
            children: <SummaryTab onOpen={openDetails} />,
          },
          {
            key: 'statements',
            label: '月度对账单',
            children: <StatementsTab />,
          },
          {
            key: 'list',
            label: '佣金明细',
            children: (
              <ListTab
                key={agentId ?? 'all'}
                agentId={agentId}
                onAgentChange={(id) =>
                  setParams(id ? { tab: 'list', agentId: id } : { tab: 'list' })
                }
              />
            ),
          },
        ]}
      />
    </Card>
  );
}

function SummaryTab({ onOpen }: { onOpen: (agentId: string) => void }) {
  const summary = useQuery({
    queryKey: ['commissions', 'summary'],
    queryFn: () => unwrap(api.GET('/api/commissions/summary')),
  });
  const rows = summary.data ?? [];
  const total = (k: keyof Omit<Summary, 'agent'>) => rows.reduce((s, r) => s + r[k], 0);

  const columns: TableColumnsType<Summary> = [
    { title: '代理', key: 'agent', render: (_, r) => <AgentLink agent={r.agent} /> },
    {
      title: '冻结中',
      key: 'frozen',
      align: 'right',
      render: (_, r) => <Money cents={r.frozenCents} />,
    },
    {
      title: '可结算',
      key: 'releasable',
      align: 'right',
      render: (_, r) => (
        <Space direction="vertical" size={0} style={{ alignItems: 'flex-end' }}>
          <Typography.Text strong type={r.releasableCents < 0 ? 'danger' : undefined}>
            {formatCents(r.releasableCents)}
          </Typography.Text>
          {r.clawbackCents !== 0 && (
            <Typography.Text type="danger" style={{ fontSize: 12 }}>
              含退款扣回 {formatCents(r.clawbackCents)}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: '已对账待打款',
      key: 'settled',
      align: 'right',
      render: (_, r) => <Money cents={r.settledCents} />,
    },
    {
      title: '已发放',
      key: 'paid',
      align: 'right',
      render: (_, r) => <Money cents={r.paidCents} />,
    },
    {
      title: '',
      key: 'actions',
      render: (_, r) => (
        <Button type="link" size="small" onClick={() => onOpen(r.agent.id)}>
          明细
        </Button>
      ),
    },
  ];

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Statistic title="冻结中" value={formatCents(total('frozenCents'))} />
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="可结算" value={formatCents(total('releasableCents'))} />
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="已对账待打款" value={formatCents(total('settledCents'))} />
        </Col>
        <Col xs={12} md={6}>
          <Statistic title="已发放" value={formatCents(total('paidCents'))} />
        </Col>
      </Row>
      <div className="page-toolbar">
        <Typography.Text type="secondary">只列出有佣金的代理（不含已作废）</Typography.Text>
        <Button icon={<ReloadOutlined />} onClick={() => void summary.refetch()}>
          刷新
        </Button>
      </div>
      <Table<Summary>
        rowKey={(r) => r.agent.id}
        columns={columns}
        dataSource={rows}
        loading={summary.isFetching}
        pagination={false}
        scroll={{ x: 760 }}
        locale={{ emptyText: '还没有佣金：代理客户的订单完成后会自动计提' }}
      />
    </Space>
  );
}

function ListTab({
  agentId,
  onAgentChange,
}: {
  agentId?: string;
  onAgentChange: (id: string | null) => void;
}) {
  const [filters, setFilters] = useState<Filters>({ page: 1, pageSize: 20, agentId });
  const list = useQuery({
    queryKey: ['commissions', filters],
    queryFn: () => unwrap(api.GET('/api/commissions', { params: { query: filters } })),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <div className="page-toolbar">
        <div className="page-toolbar-filters">
          <AgentSelect
            placeholder="代理"
            allowDisabled
            value={agentId ?? null}
            style={{ width: 180 }}
            onChange={onAgentChange}
          />
          <Select
            placeholder="状态"
            allowClear
            style={{ width: 120 }}
            options={COMMISSION_STATUSES.map((s) => ({
              value: s,
              label: COMMISSION_STATUS_LABELS[s],
            }))}
            onChange={(status?: CommissionStatus) => setFilters((f) => ({ ...f, page: 1, status }))}
          />
          <Select
            placeholder="类型"
            allowClear
            style={{ width: 120 }}
            options={(['DIRECT', 'PARENT'] as CommissionRole[]).map((r) => ({
              value: r,
              label: COMMISSION_ROLE_LABELS[r],
            }))}
            onChange={(role?: CommissionRole) => setFilters((f) => ({ ...f, page: 1, role }))}
          />
          <Input.Search
            placeholder="订单编号或客户称呼"
            allowClear
            style={{ width: 200 }}
            onSearch={(keyword) =>
              setFilters((f) => ({ ...f, page: 1, keyword: keyword || undefined }))
            }
          />
        </div>
        <Space>
          {list.data && (
            <Typography.Text>
              合计 <Money cents={list.data.sumCents} strong />
            </Typography.Text>
          )}
          <Button icon={<ReloadOutlined />} onClick={() => void list.refetch()}>
            刷新
          </Button>
        </Space>
      </div>
      <CommissionTable
        data={list.data?.items}
        loading={list.isFetching}
        hideAgent={!!agentId}
        pagination={{
          current: filters.page,
          pageSize: filters.pageSize,
          total: list.data?.total,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 条`,
          onChange: (page, pageSize) => setFilters((f) => ({ ...f, page, pageSize })),
        }}
      />
    </>
  );
}
