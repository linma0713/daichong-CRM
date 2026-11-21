import { Link } from 'react-router';
import { Space, Spin, Tag, Typography } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { formatCents } from '@crm/shared';
import { api, unwrap } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { DutySwitch } from '../components/notify';
import { MobilePage, Section, StatTiles } from './MobileLayout';

function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return '夜深了';
  if (h < 12) return '早上好';
  if (h < 18) return '下午好';
  return '晚上好';
}

/** 手机版首页：按角色列出今天要处理的事 */
export function MobileHomePage() {
  const { profile, can } = useAuth();
  const dashboard = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => unwrap(api.GET('/api/dashboard')),
    refetchInterval: 60_000,
  });
  if (!profile) return null;
  const d = dashboard.data;

  const shortcuts = [
    can('order:write') && { to: '/orders/new', label: '录入订单' },
    can('customer:read') && { to: '/scripts', label: '话术库' },
    can('report:read') && { to: '/analytics', label: '数据看板' },
    (can('ticket:create') || can('ticket:handle')) && { to: '/tickets', label: '售后工单' },
  ].filter(Boolean) as { to: string; label: string }[];

  return (
    <MobilePage title="今天" extra={<DutySwitch />}>
      <div className="m-hello">
        <Typography.Title level={5} style={{ margin: 0 }}>
          {greeting()}，{profile.displayName}
        </Typography.Title>
        <Space size={4} wrap style={{ marginTop: 6 }}>
          {profile.roles.map((r) => (
            <Tag key={r.id} color="blue" bordered={false}>
              {r.name}
            </Tag>
          ))}
        </Space>
      </div>

      {dashboard.isLoading && <Spin style={{ display: 'block', margin: 32 }} />}

      {d?.tasks && (
        <Section title="开通任务">
          <StatTiles
            items={[
              { label: '我的待办', value: d.tasks.mine, to: '/m/tasks?view=mine' },
              { label: '任务池', value: d.tasks.unassigned, to: '/m/tasks?view=pool' },
              {
                label: '已超时',
                value: d.tasks.overdue,
                to: '/m/tasks?view=overdue',
                danger: d.tasks.overdue > 0,
              },
            ]}
          />
        </Section>
      )}

      {d?.subscriptions && can('customer:read') && (
        <Section title="续费">
          <StatTiles
            items={[
              {
                label: '要提醒续费',
                value: d.subscriptions.needsReminder,
                to: '/m/renewals',
                danger: d.subscriptions.needsReminder > 0,
                hint: '我负责的',
              },
              {
                label: '7 天内到期',
                value: d.subscriptions.expiringIn7Days,
                to: '/m/renewals?view=expiring',
              },
              { label: '服务中', value: d.subscriptions.active },
            ]}
          />
        </Section>
      )}

      {d?.customers && (
        <Section title="客户">
          <StatTiles
            items={[
              {
                label: '待召回',
                value: d.customers.recallPending,
                to: '/m/customers?view=recall',
                hint: '我负责的',
              },
              { label: '本月新客户', value: d.customers.newThisMonth },
              { label: '客户总数', value: d.customers.total, to: '/m/customers?view=all' },
            ]}
          />
        </Section>
      )}

      {d?.aftersales && (
        <Section title="售后">
          <StatTiles
            items={[
              ...(can('ticket:handle')
                ? [
                    { label: '我处理的工单', value: d.aftersales.mine, to: '/tickets' },
                    {
                      label: '已超时工单',
                      value: d.aftersales.overdue,
                      to: '/tickets',
                      danger: d.aftersales.overdue > 0,
                    },
                  ]
                : []),
              ...(can('refund:approve')
                ? [
                    {
                      label: '待审批退款',
                      value: d.aftersales.pendingRefunds,
                      to: '/refunds',
                      danger: d.aftersales.pendingRefunds > 0,
                    },
                  ]
                : []),
            ]}
          />
        </Section>
      )}

      {d?.orders && (
        <Section title="订单与收款">
          <StatTiles
            columns={2}
            items={[
              { label: '今日收款', value: formatCents(d.orders.todayReceivedCents) },
              { label: '本月收款', value: formatCents(d.orders.monthReceivedCents) },
              { label: '今日新订单', value: d.orders.todayOrders, to: '/orders' },
              { label: '待收款订单', value: d.orders.pendingPayment, to: '/orders' },
            ]}
          />
        </Section>
      )}

      {d?.inventory && (
        <Section title="库存">
          <StatTiles
            columns={2}
            items={[
              { label: '在库成品号', value: d.inventory.inStock, to: '/inventory?tab=stock' },
              {
                label: '余额不足的付款资源',
                value: d.inventory.lowResources,
                to: '/inventory',
                danger: d.inventory.lowResources > 0,
              },
            ]}
          />
          {d.inventory.lowPools.length > 0 && (
            <Typography.Text type="danger" style={{ display: 'block', marginTop: 8, fontSize: 13 }}>
              成品号不足：{d.inventory.lowPools.join('、')}
            </Typography.Text>
          )}
        </Section>
      )}

      {shortcuts.length > 0 && (
        <Section title="常用">
          <div className="m-links">
            {shortcuts.map((s) => (
              <Link key={s.to} to={s.to} className="m-link-row">
                <span>{s.label}</span>
                <RightOutlined />
              </Link>
            ))}
          </div>
        </Section>
      )}
    </MobilePage>
  );
}
