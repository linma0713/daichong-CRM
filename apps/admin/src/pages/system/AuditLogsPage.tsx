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
  { value: 'customer.follow_up', label: '记录客户跟进' },
  { value: 'customer.lost_reason', label: '记录客户流失原因' },
  { value: 'script.create', label: '新增话术' },
  { value: 'script.update', label: '修改话术' },
  { value: 'script.delete', label: '删除话术' },
  { value: 'plan.create', label: '新增套餐' },
  { value: 'plan.update', label: '修改套餐' },
  { value: 'product.create', label: '新增商品' },
  { value: 'product.update', label: '修改商品售价、质保价、佣金比例或上下架' },
  { value: 'order.create', label: '录入订单' },
  { value: 'order.payment', label: '确认收款' },
  { value: 'order.cancel', label: '取消订单' },
  { value: 'task.claim', label: '领取任务' },
  { value: 'task.assign', label: '转交任务' },
  { value: 'task.duty', label: '切换在班状态' },
  { value: 'task.complete', label: '完成任务' },
  { value: 'task.fail', label: '任务标记失败' },
  { value: 'task.cancel', label: '作废任务' },
  { value: 'subscription.update', label: '手动校正订阅' },
  { value: 'account.secret_view', label: '查看账号密码' },
  { value: 'resource.create', label: '新增付款资源' },
  { value: 'resource.update', label: '修改付款资源' },
  { value: 'resource.top_up', label: '付款资源入库' },
  { value: 'resource.adjust', label: '付款资源盘点' },
  { value: 'resource.secret_view', label: '查看付款资源敏感信息' },
  { value: 'stock.create', label: '成品号入库' },
  { value: 'stock.update', label: '修改成品号库存' },
  { value: 'stock.charge', label: '登记在库成品号扣费' },
  { value: 'account.update', label: '修改账号信息' },
  { value: 'ticket.create', label: '登记售后工单' },
  { value: 'ticket.update', label: '修改工单状态 / 处理人 / 客户原因' },
  { value: 'ticket.comment', label: '工单备注' },
  { value: 'ticket.resolve', label: '工单标记已解决' },
  { value: 'ticket.close', label: '关闭工单' },
  { value: 'ticket.reopen', label: '重新打开工单' },
  { value: 'ticket.replace', label: '派换号任务' },
  { value: 'ticket.compensate', label: '补偿服务天数' },
  { value: 'refund.request', label: '申请退款' },
  { value: 'refund.approve', label: '审批退款并出账' },
  { value: 'refund.reject', label: '驳回退款' },
  { value: 'agent.create', label: '新增代理' },
  { value: 'agent.update', label: '修改代理（资料、上级、佣金比例或停用）' },
  { value: 'statement.generate', label: '生成佣金对账单' },
  { value: 'statement.confirm', label: '确认佣金对账单' },
  { value: 'statement.pay', label: '登记佣金打款' },
  { value: 'statement.cancel', label: '作废佣金对账单' },
  { value: 'channel.create', label: '新增渠道' },
  { value: 'channel.update', label: '修改渠道' },
  { value: 'channel.delete', label: '删除渠道' },
  { value: 'channel.cost.create', label: '登记投放成本' },
  { value: 'channel.cost.delete', label: '删除投放成本' },
  { value: 'referral.pay', label: '发放转介绍奖励' },
  { value: 'referral.cancel', label: '作废转介绍奖励' },
  { value: 'auth.locked', label: '账号被锁定' },
  { value: 'auth.totp_failed', label: '两步验证码错误' },
  { value: 'auth.recovery_used', label: '用恢复码登录' },
  { value: 'auth.totp_enable', label: '开启两步验证' },
  { value: 'auth.totp_disable', label: '关闭两步验证' },
  { value: 'auth.recovery_regen', label: '重新生成恢复码' },
  { value: 'auth.session_revoke', label: '让自己的某个设备退出登录' },
  { value: 'auth.session_revoke_others', label: '退出自己其他所有设备' },
  { value: 'user.unlock', label: '解锁员工账号' },
  { value: 'user.totp_reset', label: '重置员工的两步验证' },
  { value: 'user.force_logout', label: '强制员工下线' },
  { value: 'attachment.upload', label: '上传附件' },
  { value: 'attachment.delete', label: '删除附件' },
  { value: 'customer.import', label: '批量导入客户' },
  { value: 'customer.export', label: '导出客户清单' },
  { value: 'order.export', label: '导出订单清单' },
  { value: 'settings.update', label: '修改业务设置' },
  { value: 'job.sweep', label: '手动运行到期巡检' },
  { value: 'job.notify-scan', label: '手动运行消息巡检' },
  { value: 'notify.channel.create', label: '添加企业微信群机器人' },
  { value: 'notify.channel.update', label: '修改企业微信群机器人' },
  { value: 'notify.channel.delete', label: '删除企业微信群机器人' },
  { value: 'notify.channel.test', label: '发送群机器人测试消息' },
  { value: 'notify.message.retry', label: '重发群消息' },
];

const DANGER_ACTIONS = new Set([
  'auth.login_failed',
  'auth.locked',
  'auth.totp_failed',
  'auth.recovery_used',
  'auth.totp_disable',
  'user.totp_reset',
  'user.force_logout',
  'user.delete',
  'role.delete',
  'team.delete',
  'customer.delete',
  'order.cancel',
  'account.secret_view',
  'resource.secret_view',
  'subscription.update',
  'refund.approve',
  'statement.pay',
  'referral.pay',
  'attachment.delete',
  'customer.export',
  'order.export',
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
