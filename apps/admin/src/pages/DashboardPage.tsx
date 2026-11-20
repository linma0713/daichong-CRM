import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Card, Col, Descriptions, Row, Space, Statistic, Steps, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { DATA_SCOPE_LABELS, formatCents, type DataScope } from '@crm/shared';
import { api, unwrap } from '../api/client';
import { useAuth } from '../auth/AuthProvider';

/** 开发路线，和设计画布 ⑦ 分期保持一致 */
const ROADMAP = [
  { title: 'M0 底座', description: '员工账号、角色权限、小组、操作日志、一键本地启动' },
  {
    title: 'M1 主链路',
    description: '客户、商品与套餐、订单与收款、开通 / 发号任务、订阅与到期提醒、到期风控',
  },
  { title: 'M2 经营闭环', description: '付款资源与成品号库存、单笔毛利、售后与质保、数据看板' },
  { title: 'M3 代理', description: '代理录单、两级佣金、冻结期与月度对账' },
  { title: 'M4 多端与上云', description: '员工手机端（小程序 / App）、云端部署与备份' },
];

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 12) return '早上好';
  if (h < 18) return '下午好';
  return '晚上好';
}

function StatCard({
  title,
  value,
  to,
  danger,
  hint,
}: {
  title: string;
  value: ReactNode;
  to?: string;
  danger?: boolean;
  hint?: string;
}) {
  const navigate = useNavigate();
  return (
    <Card hoverable={!!to} size="small" onClick={to ? () => navigate(to) : undefined}>
      <Statistic
        title={title}
        value={value as number | string}
        valueStyle={danger ? { color: '#cf1322' } : undefined}
      />
      {hint && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {hint}
        </Typography.Text>
      )}
    </Card>
  );
}

const colProps = { xs: 12, sm: 8, lg: 6, xl: 4 };

export function DashboardPage() {
  const { profile } = useAuth();
  const dashboard = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => unwrap(api.GET('/api/dashboard')),
    refetchInterval: 60_000,
  });
  if (!profile) return null;
  const d = dashboard.data;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card>
        <Typography.Title level={4} style={{ marginTop: 0 }}>
          {greeting()}，{profile.displayName}
        </Typography.Title>
        <Descriptions column={{ xs: 1, sm: 2 }} size="small">
          <Descriptions.Item label="角色">
            <Space size={4} wrap>
              {profile.roles.map((r) => (
                <Tag key={r.id} color="blue">
                  {r.name}
                </Tag>
              ))}
              {profile.roles.length === 0 && (
                <Typography.Text type="secondary">未分配</Typography.Text>
              )}
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="数据范围">
            {DATA_SCOPE_LABELS[profile.dataScope as DataScope]}
          </Descriptions.Item>
        </Descriptions>
      </Card>

      {d?.tasks && (
        <Card title="开通任务" size="small">
          <Row gutter={[12, 12]}>
            <Col {...colProps}>
              <StatCard title="我的待办" value={d.tasks.mine} to="/tasks" />
            </Col>
            <Col {...colProps}>
              <StatCard title="任务池（没人领）" value={d.tasks.unassigned} to="/tasks" />
            </Col>
            <Col {...colProps}>
              <StatCard
                title="已超时"
                value={d.tasks.overdue}
                to="/tasks"
                danger={d.tasks.overdue > 0}
              />
            </Col>
            <Col {...colProps}>
              <StatCard title="全部未完成" value={d.tasks.open} to="/tasks" />
            </Col>
          </Row>
        </Card>
      )}

      {d?.subscriptions && (
        <Card title="订阅与续费" size="small">
          <Row gutter={[12, 12]}>
            <Col {...colProps}>
              <StatCard
                title="需要提醒续费"
                value={d.subscriptions.needsReminder}
                to="/subscriptions"
                danger={d.subscriptions.needsReminder > 0}
                hint={
                  profile.dataScope === 'SELF'
                    ? '我负责的'
                    : `我负责的；可见范围内共 ${d.subscriptions.needsReminderAll} 个`
                }
              />
            </Col>
            <Col {...colProps}>
              <StatCard
                title="7 天内到期"
                value={d.subscriptions.expiringIn7Days}
                to="/subscriptions"
              />
            </Col>
            <Col {...colProps}>
              <StatCard title="服务中" value={d.subscriptions.active} to="/subscriptions" />
            </Col>
          </Row>
        </Card>
      )}

      {(d?.orders || d?.customers) && (
        <Card title="订单与客户" size="small">
          <Row gutter={[12, 12]}>
            {d.orders && (
              <>
                <Col {...colProps}>
                  <StatCard title="待收款订单" value={d.orders.pendingPayment} to="/orders" />
                </Col>
                <Col {...colProps}>
                  <StatCard title="开通中订单" value={d.orders.fulfilling} to="/orders" />
                </Col>
                <Col {...colProps}>
                  <StatCard title="今日新订单" value={d.orders.todayOrders} to="/orders" />
                </Col>
                <Col {...colProps}>
                  <StatCard title="今日收款" value={formatCents(d.orders.todayReceivedCents)} />
                </Col>
                <Col {...colProps}>
                  <StatCard title="本月收款" value={formatCents(d.orders.monthReceivedCents)} />
                </Col>
              </>
            )}
            {d.customers && (
              <>
                <Col {...colProps}>
                  <StatCard title="客户" value={d.customers.total} to="/customers" />
                </Col>
                <Col {...colProps}>
                  <StatCard title="本月新客户" value={d.customers.newThisMonth} to="/customers" />
                </Col>
              </>
            )}
          </Row>
        </Card>
      )}

      <Card title="开发进度" size="small">
        <Steps direction="vertical" size="small" current={1} items={ROADMAP} />
      </Card>
    </Space>
  );
}
