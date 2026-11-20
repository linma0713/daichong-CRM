import { useState } from 'react';
import {
  Card,
  DatePicker,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  type TableColumnsType,
} from 'antd';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { Dayjs } from 'dayjs';
import { api, unwrap, type Schemas } from '../../api/client';
import { queryKeys } from '../../api/queries';
import { useAuth } from '../../auth/AuthProvider';
import { formatTime } from '../../components/format';

type AuditLog = Schemas['AuditLogDto'];

interface Filters {
  page: number;
  pageSize: number;
  userId?: string;
  action?: string;
  from?: string;
  to?: string;
}

/** 常见动作，方便筛选；新模块上线时在这里补充 */
const ACTIONS: { value: string; label: string }[] = [
  { value: 'auth.login', label: '登录' },
  { value: 'auth.login_failed', label: '登录失败' },
  { value: 'auth.logout', label: '退出登录' },
  { value: 'auth.change_password', label: '修改自己的密码' },
  { value: 'user.create', label: '新增员工' },
  { value: 'user.update', label: '修改员工' },
  { value: 'user.reset_password', label: '重置员工密码' },
  { value: 'user.delete', label: '删除员工' },
  { value: 'role.create', label: '新增角色' },
  { value: 'role.update', label: '修改角色权限' },
  { value: 'role.delete', label: '删除角色' },
  { value: 'team.create', label: '新增小组' },
  { value: 'team.update', label: '重命名小组' },
  { value: 'team.delete', label: '删除小组' },
  { value: 'customer.create', label: '新增客户' },
  { value: 'customer.update', label: '修改客户' },
  { value: 'customer.transfer', label: '更换客户负责人' },
  { value: 'customer.delete', label: '删除客户' },
  { value: 'customer.follow_up', label: '客户跟进' },
  { value: 'plan.create', label: '新增套餐' },
  { value: 'plan.update', label: '修改套餐' },
  { value: 'product.create', label: '新增商品' },
  { value: 'product.update', label: '修改商品售价' },
  { value: 'order.create', label: '录入订单' },
  { value: 'order.payment', label: '确认收款' },
  { value: 'order.cancel', label: '取消订单' },
  { value: 'task.claim', label: '领取任务' },
  { value: 'task.assign', label: '转交任务' },
  { value: 'task.complete', label: '完成任务' },
  { value: 'task.fail', label: '任务失败' },
  { value: 'task.cancel', label: '作废任务' },
  { value: 'subscription.update', label: '手动校正订阅' },
  { value: 'account.secret_view', label: '查看账号密码' },
  { value: 'account.update', label: '修改账号信息' },
  { value: 'settings.update', label: '修改业务设置' },
  { value: 'job.sweep', label: '手动运行到期巡检' },
];

const DANGER_ACTIONS = new Set([
  'auth.login_failed',
  'user.delete',
  'role.delete',
  'team.delete',
  'customer.delete',
  'order.cancel',
  'account.secret_view',
  'subscription.update',
]);

export function AuditLogsPage() {
  const { can } = useAuth();
  const [filters, setFilters] = useState<Filters>({ page: 1, pageSize: 20 });

  const logs = useQuery({
    queryKey: queryKeys.auditLogs(filters),
    queryFn: () => unwrap(api.GET('/api/audit-logs', { params: { query: filters } })),
    placeholderData: keepPreviousData,
  });
  // 按员工筛选需要能查看员工列表
  const staff = useQuery({
    queryKey: queryKeys.users({ page: 1, pageSize: 100 }),
    queryFn: () => unwrap(api.GET('/api/users', { params: { query: { page: 1, pageSize: 100 } } })),
    enabled: can('system:user:read'),
  });

  const onRange = (range: [Dayjs | null, Dayjs | null] | null) =>
    setFilters((f) => ({
      ...f,
      page: 1,
      from: range?.[0]?.startOf('day').toISOString(),
      to: range?.[1]?.endOf('day').toISOString(),
    }));

  const columns: TableColumnsType<AuditLog> = [
    { title: '时间', key: 'createdAt', width: 150, render: (_, l) => formatTime(l.createdAt) },
    {
      title: '员工',
      key: 'user',
      width: 140,
      render: (_, l) => (l.user ? `${l.user.displayName}（${l.user.username}）` : '—'),
    },
    {
      title: '操作',
      key: 'summary',
      render: (_, l) => (
        <Space size={6} wrap>
          <Tag color={DANGER_ACTIONS.has(l.action) ? 'red' : 'blue'}>{l.summary}</Tag>
          {l.path && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {l.method} {l.path}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    { title: 'IP', dataIndex: 'ip', width: 140, render: (ip: string | null) => ip ?? '—' },
  ];

  return (
    <Card title="操作日志">
      <div className="page-toolbar">
        <div className="page-toolbar-filters">
          {can('system:user:read') && (
            <Select
              placeholder="员工"
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: 180 }}
              loading={staff.isLoading}
              options={(staff.data?.items ?? []).map((u) => ({
                value: u.id,
                label: `${u.displayName}（${u.username}）`,
              }))}
              onChange={(userId?: string) => setFilters((f) => ({ ...f, page: 1, userId }))}
            />
          )}
          <Select
            placeholder="操作类型"
            allowClear
            showSearch
            optionFilterProp="label"
            style={{ width: 160 }}
            options={ACTIONS}
            onChange={(action?: string) => setFilters((f) => ({ ...f, page: 1, action }))}
          />
          <DatePicker.RangePicker onChange={onRange} />
        </div>
      </div>
      <Table<AuditLog>
        rowKey="id"
        size="middle"
        columns={columns}
        dataSource={logs.data?.items}
        loading={logs.isFetching}
        scroll={{ x: 760 }}
        expandable={{
          rowExpandable: (l) => Boolean(l.detail || l.resourceId),
          expandedRowRender: (l) => (
            <Space direction="vertical" style={{ width: '100%' }}>
              {l.resourceId && (
                <Typography.Text type="secondary">对象 ID：{l.resourceId}</Typography.Text>
              )}
              {l.detail && <pre className="json-detail">{JSON.stringify(l.detail, null, 2)}</pre>}
            </Space>
          ),
        }}
        pagination={{
          current: filters.page,
          pageSize: filters.pageSize,
          total: logs.data?.total,
          showSizeChanger: true,
          showTotal: (total) => `共 ${total} 条`,
          onChange: (page, pageSize) => setFilters((f) => ({ ...f, page, pageSize })),
        }}
      />
    </Card>
  );
}
