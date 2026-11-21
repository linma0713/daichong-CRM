import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { hasPermission } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../common/auth-user';
import { addDays, startOfLocalDay, startOfLocalMonth } from '../common/dates';
import { uncontactedSinceServiceEnd, visibleCustomers } from '../customers/customers';
import { visibleOrders } from '../orders/orders';
import { InventoryModule, InventoryService } from '../inventory/inventory';
import { visibleRefunds, visibleTickets } from '../aftersales/aftersales';
import {
  SubscriptionsModule,
  SubscriptionsService,
  visibleSubscriptions,
} from '../subscriptions/subscriptions';

export class OrderStatsDto {
  @ApiProperty({ description: '待收款订单数' }) pendingPayment: number;
  @ApiProperty({ description: '已收款、开通中的订单数' }) fulfilling: number;
  @ApiProperty({ description: '今天新录入的订单数' }) todayOrders: number;
  @ApiProperty({ description: '今天确认的收款（分）' }) todayReceivedCents: number;
  @ApiProperty({ description: '本月确认的收款（分）' }) monthReceivedCents: number;
}

export class TaskStatsDto {
  @ApiProperty({ description: '分给我的未完成任务' }) mine: number;
  @ApiProperty({ description: '任务池里没人领的' }) unassigned: number;
  @ApiProperty({ description: '已超时未完成' }) overdue: number;
  @ApiProperty({ description: '全部未完成' }) open: number;
}

export class SubscriptionStatsDto {
  @ApiProperty({ description: '服务中' }) active: number;
  @ApiProperty({ description: '7 天内到期' }) expiringIn7Days: number;
  @ApiProperty({ description: '需要提醒续费（我负责的）' }) needsReminder: number;
  @ApiProperty({ description: '需要提醒续费（数据范围内全部）' }) needsReminderAll: number;
}

export class CustomerStatsDto {
  @ApiProperty() total: number;
  @ApiProperty({ description: '本月新增' }) newThisMonth: number;
  @ApiProperty({ description: '待召回：沉睡、服务结束后还没联系过的（我负责的）' })
  recallPending: number;
}

export class InventoryAlertDto {
  @ApiProperty({ description: '余额低于预警线的付款资源数' }) lowResources: number;
  @ApiProperty({ type: [String], description: '在库成品号不足的套餐' }) lowPools: string[];
  @ApiProperty({ description: '在库成品号总数' }) inStock: number;
}

export class AftersalesStatsDto {
  @ApiProperty({ description: '未解决的工单（数据范围内）' }) open: number;
  @ApiProperty({ description: '我处理的未解决工单' }) mine: number;
  @ApiProperty({ description: '没人处理的' }) unassigned: number;
  @ApiProperty({ description: '已超时（含已升级）' }) overdue: number;
  @ApiProperty({ description: '待审批的退款（有审批权限时才统计，否则为 0）' })
  pendingRefunds: number;
}

export class CommissionStatsDto {
  @ApiProperty({ description: '待确认的佣金对账单' }) draftStatements: number;
  @ApiProperty({ description: '已确认、待打款的佣金对账单' }) unpaidStatements: number;
  @ApiProperty({ description: '待打款合计（分，负数表示代理要补交）' }) unpaidCents: number;
  @ApiProperty({ description: '可结算、还没进对账单的佣金（分）' }) unstatementedCents: number;
}

export class DashboardDto {
  @ApiProperty({ type: OrderStatsDto, nullable: true, description: '有「查看订单」权限时返回' })
  orders: OrderStatsDto | null;
  @ApiProperty({ type: TaskStatsDto, nullable: true, description: '有「处理开通任务」权限时返回' })
  tasks: TaskStatsDto | null;
  @ApiProperty({ type: SubscriptionStatsDto, nullable: true })
  subscriptions: SubscriptionStatsDto | null;
  @ApiProperty({ type: CustomerStatsDto, nullable: true }) customers: CustomerStatsDto | null;
  @ApiProperty({ type: InventoryAlertDto, nullable: true, description: '有「查看库存」权限时返回' })
  inventory: InventoryAlertDto | null;
  @ApiProperty({
    type: AftersalesStatsDto,
    nullable: true,
    description: '有售后或退款审批权限时返回',
  })
  aftersales: AftersalesStatsDto | null;
  @ApiProperty({
    type: CommissionStatsDto,
    nullable: true,
    description: '有「佣金结算」权限时返回',
  })
  commissions: CommissionStatsDto | null;
}

const OPEN = { in: ['PENDING' as const, 'IN_PROGRESS' as const, 'FAILED' as const] };

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subs: SubscriptionsService,
    private readonly inventorySvc: InventoryService,
  ) {}

  async summary(user: AuthUser): Promise<DashboardDto> {
    const can = (code: string) => hasPermission(user.permissions, code);
    const now = new Date();
    const today = startOfLocalDay(now);
    const month = startOfLocalMonth(now);

    const orders = can('order:read')
      ? (async (): Promise<OrderStatsDto> => {
          const scope = visibleOrders(user);
          const [pendingPayment, fulfilling, todayOrders, todaySum, monthSum] = await Promise.all([
            this.prisma.order.count({ where: { ...scope, status: 'PENDING_PAYMENT' } }),
            this.prisma.order.count({ where: { ...scope, status: 'FULFILLING' } }),
            this.prisma.order.count({ where: { ...scope, createdAt: { gte: today } } }),
            this.prisma.payment.aggregate({
              where: { receivedAt: { gte: today }, order: scope },
              _sum: { amountCents: true },
            }),
            this.prisma.payment.aggregate({
              where: { receivedAt: { gte: month }, order: scope },
              _sum: { amountCents: true },
            }),
          ]);
          return {
            pendingPayment,
            fulfilling,
            todayOrders,
            todayReceivedCents: todaySum._sum.amountCents ?? 0,
            monthReceivedCents: monthSum._sum.amountCents ?? 0,
          };
        })()
      : null;

    const tasks = can('fulfillment:handle')
      ? (async (): Promise<TaskStatsDto> => {
          const [mine, unassigned, overdue, open] = await Promise.all([
            this.prisma.fulfillmentTask.count({ where: { status: OPEN, assigneeId: user.id } }),
            this.prisma.fulfillmentTask.count({ where: { status: OPEN, assigneeId: null } }),
            this.prisma.fulfillmentTask.count({ where: { status: OPEN, dueAt: { lt: now } } }),
            this.prisma.fulfillmentTask.count({ where: { status: OPEN } }),
          ]);
          return { mine, unassigned, overdue, open };
        })()
      : null;

    const subscriptions =
      can('customer:read') || can('subscription:read')
        ? (async (): Promise<SubscriptionStatsDto> => {
            const scope = visibleSubscriptions(user);
            const [active, expiringIn7Days, needsReminder, needsReminderAll] = await Promise.all([
              this.prisma.subscription.count({ where: { ...scope, status: 'ACTIVE' } }),
              this.prisma.subscription.count({
                where: { ...scope, status: 'ACTIVE', endAt: { lte: addDays(now, 7) } },
              }),
              this.subs.countNeedsReminder(user, user.id),
              this.subs.countNeedsReminder(user),
            ]);
            return { active, expiringIn7Days, needsReminder, needsReminderAll };
          })()
        : null;

    const customers = can('customer:read')
      ? (async (): Promise<CustomerStatsDto> => {
          const scope = visibleCustomers(user);
          const [total, newThisMonth, recallPending] = await Promise.all([
            this.prisma.customer.count({ where: scope }),
            this.prisma.customer.count({ where: { ...scope, createdAt: { gte: month } } }),
            this.prisma.customer.count({
              where: {
                AND: [
                  scope,
                  { ownerId: user.id, stage: 'DORMANT' },
                  uncontactedSinceServiceEnd(this.prisma),
                ],
              },
            }),
          ]);
          return { total, newThisMonth, recallPending };
        })()
      : null;

    const inventory = can('inventory:read')
      ? this.inventorySvc.summary().then((sum): InventoryAlertDto => ({
          lowResources: sum.lowResources.length,
          lowPools: sum.pools.filter((p) => p.low).map((p) => p.planName),
          inStock: sum.pools.reduce((n, p) => n + p.inStock, 0),
        }))
      : null;

    const aftersales =
      can('ticket:create') || can('ticket:handle') || can('refund:approve')
        ? (async (): Promise<AftersalesStatsDto> => {
            const scope = visibleTickets(user);
            const unresolved = {
              in: ['OPEN' as const, 'IN_PROGRESS' as const, 'WAITING_CUSTOMER' as const],
            };
            const [open, mine, unassigned, overdue, pendingRefunds] = await Promise.all([
              this.prisma.ticket.count({ where: { ...scope, status: unresolved } }),
              this.prisma.ticket.count({ where: { status: unresolved, assigneeId: user.id } }),
              this.prisma.ticket.count({
                where: { ...scope, status: unresolved, assigneeId: null },
              }),
              this.prisma.ticket.count({
                where: { ...scope, status: { in: ['OPEN', 'IN_PROGRESS'] }, dueAt: { lt: now } },
              }),
              can('refund:approve')
                ? this.prisma.refund.count({
                    where: { ...visibleRefunds(user), status: 'PENDING' },
                  })
                : Promise.resolve(0),
            ]);
            return { open, mine, unassigned, overdue, pendingRefunds };
          })()
        : null;

    const commissions = can('commission:settle')
      ? (async (): Promise<CommissionStatsDto> => {
          const [groups, unstatemented] = await Promise.all([
            this.prisma.commissionStatement.groupBy({
              by: ['status'],
              where: { status: { in: ['DRAFT', 'CONFIRMED'] } },
              _count: { _all: true },
              _sum: { payableCents: true },
            }),
            this.prisma.commission.aggregate({
              where: { status: 'RELEASABLE', statementId: null },
              _sum: { amountCents: true },
            }),
          ]);
          const draft = groups.find((g) => g.status === 'DRAFT');
          const confirmed = groups.find((g) => g.status === 'CONFIRMED');
          return {
            draftStatements: draft?._count._all ?? 0,
            unpaidStatements: confirmed?._count._all ?? 0,
            unpaidCents: confirmed?._sum.payableCents ?? 0,
            unstatementedCents: unstatemented._sum.amountCents ?? 0,
          };
        })()
      : null;

    const [o, t, s, c, i, a, m] = await Promise.all([
      orders,
      tasks,
      subscriptions,
      customers,
      inventory,
      aftersales,
      commissions,
    ]);
    return {
      orders: o,
      tasks: t,
      subscriptions: s,
      customers: c,
      inventory: i,
      aftersales: a,
      commissions: m,
    };
  }
}

@ApiTags('首页')
@ApiBearerAuth()
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @ApiOperation({ summary: '首页统计（按权限返回对应板块）' })
  @ApiOkResponse({ type: DashboardDto })
  summary(@CurrentUser() user: AuthUser): Promise<DashboardDto> {
    return this.dashboard.summary(user);
  }
}

@Module({
  imports: [SubscriptionsModule, InventoryModule],
  providers: [DashboardService],
  controllers: [DashboardController],
})
export class DashboardModule {}
