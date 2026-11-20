import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Button,
  Card,
  Input,
  Select,
  Space,
  Table,
  Typography,
  type TableColumnsType,
  type TablePaginationConfig,
} from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  ORDER_KIND_LABELS,
  ORDER_STATUS_LABELS,
  ORDER_STATUSES,
  type OrderKind,
  type OrderStatus,
} from '@crm/shared';
import { api, unwrap, type QueryOf, type Schemas } from '../../api/client';
import { useAuth } from '../../auth/AuthProvider';
import { CustomerLink, Money, OrderKindTag, OrderStatusTag } from '../../components/business';
import { formatTime } from '../../components/format';

type Order = Schemas['OrderDto'];
type Filters = QueryOf<'/api/orders'> & { page: number; pageSize: number };

export function OrdersPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<Filters>({ page: 1, pageSize: 20 });
  const orders = useQuery({
    queryKey: ['orders', filters],
    queryFn: () => unwrap(api.GET('/api/orders', { params: { query: filters } })),
    placeholderData: keepPreviousData,
  });

  return (
    <Card
      title="订单"
      extra={
        can('order:write') && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate('/orders/new')}>
            录入订单
          </Button>
        )
      }
    >
      <div className="page-toolbar">
        <div className="page-toolbar-filters">
          <Input.Search
            placeholder="订单编号、客户称呼、账号邮箱"
            allowClear
            style={{ width: 240 }}
            onSearch={(keyword) =>
              setFilters((f) => ({ ...f, page: 1, keyword: keyword || undefined }))
            }
          />
          <Select
            placeholder="状态"
            allowClear
            style={{ width: 110 }}
            options={ORDER_STATUSES.map((s) => ({ value: s, label: ORDER_STATUS_LABELS[s] }))}
            onChange={(status?: OrderStatus) => setFilters((f) => ({ ...f, page: 1, status }))}
          />
          <Select
            placeholder="类型"
            allowClear
            style={{ width: 100 }}
            options={(['NEW', 'RENEWAL'] as OrderKind[]).map((k) => ({
              value: k,
              label: ORDER_KIND_LABELS[k],
            }))}
            onChange={(kind?: OrderKind) => setFilters((f) => ({ ...f, page: 1, kind }))}
          />
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void orders.refetch()}>
          刷新
        </Button>
      </div>
      <OrderTable
        data={orders.data?.items}
        loading={orders.isFetching}
        pagination={{
          current: filters.page,
          pageSize: filters.pageSize,
          total: orders.data?.total,
          showSizeChanger: true,
          showTotal: (total: number) => `共 ${total} 单`,
          onChange: (page: number, pageSize: number) =>
            setFilters((f) => ({ ...f, page, pageSize })),
        }}
      />
    </Card>
  );
}

/** 订单表格：订单页和客户详情页共用 */
export function OrderTable({
  data,
  loading,
  pagination = false,
  hideCustomer = false,
}: {
  data?: Order[];
  loading?: boolean;
  pagination?: false | TablePaginationConfig;
  hideCustomer?: boolean;
}) {
  const columns: TableColumnsType<Order> = [
    {
      title: '订单',
      key: 'code',
      render: (_, o) => (
        <Space direction="vertical" size={0}>
          <Link to={`/orders/${o.id}`}>{o.code}</Link>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatTime(o.createdAt)}
          </Typography.Text>
        </Space>
      ),
    },
    ...(hideCustomer
      ? []
      : [
          {
            title: '客户',
            key: 'customer',
            render: (_: unknown, o: Order) => <CustomerLink customer={o.customer} />,
          },
        ]),
    {
      title: '商品',
      key: 'product',
      render: (_, o) => (
        <Space direction="vertical" size={0}>
          <Space size={4}>
            <OrderKindTag kind={o.kind} />
            <span>{o.productName}</span>
          </Space>
          {o.accountEmail && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {o.accountEmail}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: '金额',
      key: 'amount',
      render: (_, o) => (
        <Space direction="vertical" size={0}>
          <Money cents={o.amountCents} strong />
          {o.paidCents > 0 && o.paidCents < o.amountCents && (
            <Typography.Text type="warning" style={{ fontSize: 12 }}>
              已收 <Money cents={o.paidCents} />
            </Typography.Text>
          )}
          {o.discountCents > 0 && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              优惠 <Money cents={o.discountCents} />
            </Typography.Text>
          )}
        </Space>
      ),
    },
    { title: '状态', key: 'status', render: (_, o) => <OrderStatusTag status={o.status} /> },
    { title: '负责客服', key: 'owner', render: (_, o) => o.owner.displayName },
  ];
  return (
    <Table<Order>
      rowKey="id"
      size={hideCustomer ? 'small' : undefined}
      columns={columns}
      dataSource={data}
      loading={loading}
      scroll={{ x: 860 }}
      pagination={pagination}
    />
  );
}
