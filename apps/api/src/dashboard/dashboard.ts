import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { hasPermission } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../common/auth-user';
import { addDays, startOfLocalDay, startOfLocalMonth } from '../common/dates';
import { visibleCustomers } from '../customers/customers';
import { visibleOrders } from '../orders/orders';
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
}

export class CustomerStatsDto {
  @ApiProperty() total: number;
  @ApiProperty({ description: '本月新增' }) newThisMonth: number;
}

export class DashboardDto {
  @ApiProperty({ type: OrderStatsDto, nullable: true, description: '有「查看订单」权限时返回' })
  orders: OrderStatsDto | null;
  @ApiProperty({ type: TaskStatsDto, nullable: true, description: '有「处理开通任务」权限时返回' })
  tasks: TaskStatsDto | null;
  @ApiProperty({ type: SubscriptionStatsDto, nullable: true })
  subscriptions: SubscriptionStatsDto | null;
  @ApiProperty({ type: CustomerStatsDto, nullable: true }) customers: CustomerStatsDto | null;
}

const OPEN = { in: ['PENDING' as const, 'IN_PROGRESS' as const, 'FAILED' as const] };

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subs: SubscriptionsService,
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
            const [active, expiringIn7Days, needsReminder] = await Promise.all([
              this.prisma.subscription.count({ where: { ...scope, status: 'ACTIVE' } }),
              this.prisma.subscription.count({
                where: { ...scope, status: 'ACTIVE', endAt: { lte: addDays(now, 7) } },
              }),
              // 续费提醒是客服的事：只统计自己负责的
              this.subs.countNeedsReminder(user, user.id),
            ]);
            return { active, expiringIn7Days, needsReminder };
          })()
        : null;

    const customers = can('customer:read')
      ? (async (): Promise<CustomerStatsDto> => {
          const scope = visibleCustomers(user);
          const [total, newThisMonth] = await Promise.all([
            this.prisma.customer.count({ where: scope }),
            this.prisma.customer.count({ where: { ...scope, createdAt: { gte: month } } }),
          ]);
          return { total, newThisMonth };
        })()
      : null;

    const [o, t, s, c] = await Promise.all([orders, tasks, subscriptions, customers]);
    return { orders: o, tasks: t, subscriptions: s, customers: c };
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
  imports: [SubscriptionsModule],
  providers: [DashboardService],
  controllers: [DashboardController],
})
export class DashboardModule {}
