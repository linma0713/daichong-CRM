import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Badge,
  Button,
  Card,
  Input,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
  type TableColumnsType,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { TICKET_TYPES, TICKET_TYPE_LABELS, type TicketType } from '@crm/shared';
import { api, unwrap, type QueryOf, type Schemas } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { CustomerLink, TicketStatusTag, TicketTypeTag } from '../../components/business';
import { formatTime } from '../../components/format';
import { NewTicketModal } from './modals';

type Ticket = Schemas['TicketDto'];
type View = 'mine' | 'unassigned' | 'open' | 'overdue' | 'closed';
type Filters = QueryOf<'/api/tickets'> & { page: number; pageSize: number };

const VIEW_QUERY: Record<View, Partial<Filters>> = {
  mine: { view: 'open', assignee: 'me' },
  unassigned: { view: 'open', assignee: 'unassigned' },
  open: { view: 'open' },
  overdue: { view: 'open', overdue: true },
  closed: { view: 'closed' },
};

export function TicketsPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const handler = can('ticket:handle');
  const [view, setView] = useState<View>(handler ? 'mine' : 'open');
  const [creating, setCreating] = useState(false);
  const [filters, setFilters] = useState<{
    page: number;
    pageSize: number;
    type?: TicketType;
    keyword?: string;
  }>({ page: 1, pageSize: 20 });
  const query: Filters = { ...filters, ...VIEW_QUERY[view] };
  const tickets = useQuery({
    queryKey: ['tickets', query],
    queryFn: () => unwrap(api.GET('/api/tickets', { params: { query } })),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
  const dashboard = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => unwrap(api.GET('/api/dashboard')),
  });
  const stats = dashboard.data?.aftersales;

  const label = (text: string, count?: number, danger = false) => (
    <Space size={6}>
      {text}
      {count ? <Badge count={count} color={danger ? 'red' : 'blue'} /> : null}
    </Space>
  );

  const columns: TableColumnsType<Ticket> = [
    {
      title: '工单',
      key: 'code',
      width: 120,
      render: (_, t) => (
        <Space direction="vertical" size={2}>
          <Link to={`/tickets/${t.id}`}>{t.code}</Link>
          <TicketTypeTag type={t.type} />
        </Space>
      ),
    },
    {
      title: '客户',
      key: 'customer',
      width: 150,
      render: (_, t) => <CustomerLink customer={t.customer} />,
    },
    {
      title: '问题',
      key: 'description',
      render: (_, t) => (
        <Space direction="vertical" size={0} style={{ fontSize: 13 }}>
          <Typography.Paragraph ellipsis={{ rows: 2 }} style={{ marginBottom: 0 }}>
            {t.description}
          </Typography.Paragraph>
          {t.subscription && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t.subscription.code} {t.subscription.planName} · {t.subscription.accountEmail}
            </Typography.Text>
          )}
          {t.customerFaultLabel && <Tag color="default">客户原因：{t.customerFaultLabel}</Tag>}
        </Space>
      ),
    },
    {
      title: '处理时限',
      key: 'dueAt',
      width: 160,
      render: (_, t) =>
        t.status === 'RESOLVED' || t.status === 'CLOSED' ? (
          <Typography.Text type="secondary">
            {t.status === 'CLOSED' ? '关闭' : '解决'}于 {formatTime(t.closedAt ?? t.resolvedAt)}
          </Typography.Text>
        ) : (
          <Space direction="vertical" size={0}>
            <span>{formatTime(t.dueAt)}</span>
            <Space size={4}>
              {t.overdue && <Tag color="red">已超时</Tag>}
              {t.escalatedAt && <Tag color="volcano">已升级</Tag>}
            </Space>
          </Space>
        ),
    },
    {
      title: '处理人',
      key: 'assignee',
      width: 120,
      render: (_, t) => (
        <Space direction="vertical" size={0}>
          {t.assignee ? (
            t.assignee.displayName
          ) : (
            <Typography.Text type="secondary">待领取</Typography.Text>
          )}
          <TicketStatusTag status={t.status} />
        </Space>
      ),
    },
    {
      title: '登记',
      key: 'createdAt',
      width: 150,
      render: (_, t) => (
        <Space direction="vertical" size={0} style={{ fontSize: 12 }}>
          <span>{formatTime(t.createdAt)}</span>
          <Typography.Text type="secondary">{t.createdBy.displayName}</Typography.Text>
        </Space>
      ),
    },
  ];

  return (
    <Card title="售后工单">
      <Tabs
        activeKey={view}
        onChange={(k) => {
          setView(k as View);
          setFilters((f) => ({ ...f, page: 1 }));
        }}
        items={[
          ...(handler
            ? [
                { key: 'mine', label: label('我处理的', stats?.mine) },
                { key: 'unassigned', label: label('待领取', stats?.unassigned) },
              ]
            : []),
          { key: 'open', label: label('全部未解决', stats?.open) },
          { key: 'overdue', label: label('已超时', stats?.overdue, true) },
          { key: 'closed', label: '已解决 / 已关闭' },
        ]}
      />
      <div className="page-toolbar">
        <div className="page-toolbar-filters">
          <Input.Search
            placeholder="工单编号、客户称呼、账号邮箱"
            allowClear
            style={{ width: 240 }}
            onSearch={(keyword) =>
              setFilters((f) => ({ ...f, page: 1, keyword: keyword || undefined }))
            }
          />
          <Select
            placeholder="问题类型"
            allowClear
            style={{ width: 140 }}
            options={TICKET_TYPES.map((t) => ({ value: t, label: TICKET_TYPE_LABELS[t] }))}
            onChange={(type?: TicketType) => setFilters((f) => ({ ...f, page: 1, type }))}
          />
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} onClick={() => void tickets.refetch()}>
            刷新
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>
            登记工单
          </Button>
        </Space>
      </div>
      <Table<Ticket>
        rowKey="id"
        columns={columns}
        dataSource={tickets.data?.items}
        loading={tickets.isFetching}
        scroll={{ x: 1000 }}
        rowClassName={(t) => (t.overdue ? 'row-overdue' : '')}
        onRow={(t) => ({
          onDoubleClick: () => void navigate(`/tickets/${t.id}`),
        })}
        pagination={{
          current: filters.page,
          pageSize: filters.pageSize,
          total: tickets.data?.total,
          showSizeChanger: true,
          showTotal: (total: number) => `共 ${total} 个`,
          onChange: (page: number, pageSize: number) =>
            setFilters((f) => ({ ...f, page, pageSize })),
        }}
      />
      {creating && (
        <NewTicketModal
          onClose={() => setCreating(false)}
          onCreated={(id) => void navigate(`/tickets/${id}`)}
        />
      )}
    </Card>
  );
}
