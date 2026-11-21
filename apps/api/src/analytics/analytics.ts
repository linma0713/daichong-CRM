import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional } from 'class-validator';
import type { Prisma } from '@prisma/client';
import {
  CUSTOMER_SOURCES,
  CUSTOMER_STAGES,
  TICKET_TYPES,
  displayNo,
  type TicketType,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import type { AuthUser } from '../common/auth-user';
import { CustomerBriefDto, customerBriefSelect } from '../common/briefs';
import { addDays, localDateKey, startOfLocalDay } from '../common/dates';
import { scopeWhere } from '../common/data-scope';
import { canSeeCost, orderMargin, toCustomerBrief } from '../orders/orders';
import { LostReasonCountDto, StageCountDto, visibleCustomers } from '../customers/customers';

const WINDOWS = [7, 30, 90] as const;

export class AnalyticsQueryDto {
  @ApiPropertyOptional({ enum: WINDOWS, default: 30, description: '统计最近多少天（含今天）' })
  @IsOptional()
  @Type(() => Number)
  @IsIn(WINDOWS)
  days?: number;
}

export class TrendDayDto {
  @ApiProperty({ example: '2026-11-20' }) date: string;
  @ApiProperty({ description: '收款（分）' }) receivedCents: number;
  @ApiProperty({ description: '退款出账（分）' }) refundedCents: number;
  @ApiProperty({ description: '收齐款的订单数' }) paidOrders: number;
  @ApiProperty({ description: '其中续费订单数' }) renewalOrders: number;
  @ApiProperty({ description: '新客户数' }) newCustomers: number;
  @ApiProperty({ description: '完成开通数' }) activations: number;
  @ApiProperty({ description: '新售后工单数' }) tickets: number;
}

export class RenewalGroupDto {
  @ApiProperty() key: string;
  @ApiProperty() label: string;
  @ApiProperty({ description: '服务期在统计区间内结束的订单数' }) due: number;
  @ApiProperty({ description: '其中已续费的' }) renewed: number;
  @ApiProperty({ type: Number, nullable: true, description: '续费率（0–1）' }) rate: number | null;
}

export class RenewalStatsDto extends RenewalGroupDto {
  @ApiProperty({ type: [RenewalGroupDto] }) byPlan: RenewalGroupDto[];
}

export class ActivationStatsDto {
  @ApiProperty({ description: '区间内完成的开通任务数' }) done: number;
  @ApiProperty({ description: '在时限内完成的' }) onTime: number;
  @ApiProperty({ type: Number, nullable: true }) onTimeRate: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '收齐款到开通完成的平均分钟数' })
  avgMinutes: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '中位数（分钟）' })
  medianMinutes: number | null;
}

export class TicketTypeCountDto {
  @ApiProperty() type: string;
  @ApiProperty() count: number;
}

export class AftersalesRateDto {
  @ApiProperty({ description: '新工单数' }) tickets: number;
  @ApiProperty({ description: '出过工单的订阅数' }) subscriptionsWithTickets: number;
  @ApiProperty({ description: '区间内在服务的订阅数' }) activeSubscriptions: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: '售后率 = 出过工单的订阅 ÷ 在服务订阅',
  })
  ticketRate: number | null;
  @ApiProperty({ description: '退款出账（分）' }) refundedCents: number;
  @ApiProperty({ description: '收款（分）' }) receivedCents: number;
  @ApiProperty({ type: Number, nullable: true, description: '退款率 = 退款 ÷ 收款' })
  refundRate: number | null;
  @ApiProperty({ description: '区间内解决的工单数' }) resolved: number;
  @ApiProperty({ type: Number, nullable: true, description: '平均解决用时（小时）' })
  avgResolveHours: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '按时解决率（没有被升级）' })
  onTimeRate: number | null;
  @ApiProperty({ type: [TicketTypeCountDto] }) byType: TicketTypeCountDto[];
}

export class SalesPerfDto {
  @ApiProperty() userId: string;
  @ApiProperty() name: string;
  @ApiProperty({ description: '收齐款的订单数' }) paidOrders: number;
  @ApiProperty({ description: '其中续费订单' }) renewalOrders: number;
  @ApiProperty({ description: '订单实收（分）' }) paidCents: number;
  @ApiProperty({ type: Number, nullable: true, description: '毛利（分），没有财务权限时为空' })
  marginCents: number | null;
  @ApiProperty({ description: '新客户数' }) newCustomers: number;
}

export class FulfillmentPerfDto {
  @ApiProperty() userId: string;
  @ApiProperty() name: string;
  @ApiProperty({ description: '完成的任务数（所有类型）' }) done: number;
  @ApiProperty({ type: Number, nullable: true }) onTimeRate: number | null;
  @ApiProperty({ description: '其中开通任务数' }) activations: number;
  @ApiProperty({ type: Number, nullable: true, description: '开通平均用时（分钟）' })
  avgActivationMinutes: number | null;
}

export class AftersalesPerfDto {
  @ApiProperty() userId: string;
  @ApiProperty() name: string;
  @ApiProperty({ description: '解决的工单数' }) resolved: number;
  @ApiProperty({ type: Number, nullable: true, description: '平均解决用时（小时）' })
  avgHours: number | null;
  @ApiProperty({ description: '被升级过的工单数' }) escalated: number;
}

export class StaffPerfDto {
  @ApiProperty({ type: [SalesPerfDto] }) sales: SalesPerfDto[];
  @ApiProperty({ type: [FulfillmentPerfDto] }) fulfillment: FulfillmentPerfDto[];
  @ApiProperty({ type: [AftersalesPerfDto] }) aftersales: AftersalesPerfDto[];
}

export class LtvSourceDto {
  @ApiProperty() source: string;
  @ApiProperty() label: string;
  @ApiProperty() customers: number;
  @ApiProperty({ description: '平均净收入（分）' }) avgNetCents: number;
}

export class LtvCustomerDto {
  @ApiProperty({ type: CustomerBriefDto }) customer: CustomerBriefDto;
  @ApiProperty() orders: number;
  @ApiProperty({ description: '累计净收入 = 实收 − 退款（分）' }) netCents: number;
  @ApiProperty({ type: Number, nullable: true }) marginCents: number | null;
  @ApiProperty() firstPaidAt: Date;
  @ApiProperty() lastPaidAt: Date;
}

/** 客户价值（全部历史，不受统计区间影响） */
export class LtvStatsDto {
  @ApiProperty({ description: '付过款的客户数' }) payingCustomers: number;
  @ApiProperty({ description: '复购客户数（收齐款的订单 ≥ 2）' }) repeatCustomers: number;
  @ApiProperty({ type: Number, nullable: true, description: '平均客户净收入（分）' })
  avgNetCents: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '平均客户毛利（分）' })
  avgMarginCents: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '平均订单数' })
  avgOrders: number | null;
  @ApiProperty({ type: [LtvSourceDto] }) bySource: LtvSourceDto[];
  @ApiProperty({ type: [LtvCustomerDto], description: '净收入最高的 10 个客户' })
  top: LtvCustomerDto[];
}

export class AgentPerfDto {
  @ApiProperty() agentId: string;
  @ApiProperty({ example: 'A00001' }) code: string;
  @ApiProperty() name: string;
  @ApiProperty({ description: '区间内新绑定的客户数' }) newCustomers: number;
  @ApiProperty({ description: '区间内收齐款的订单数' }) paidOrders: number;
  @ApiProperty({ description: '其中客户首单' }) firstOrders: number;
  @ApiProperty({ description: '这些订单的实收 − 已退（分）' }) salesCents: number;
  @ApiProperty({ description: '这些订单上的代理佣金（分，含上级管理佣金）' })
  commissionCents: number;
}

/** 客户分层快照（现在的状态，不受统计区间影响） */
export class SegmentSnapshotDto {
  @ApiProperty({ type: [StageCountDto] }) stages: StageCountDto[];
  @ApiProperty({ type: [LostReasonCountDto], description: '沉睡 + 流失客户的流失原因' })
  lostReasons: LostReasonCountDto[];
}

export class AnalyticsDto {
  @ApiProperty() from: string;
  @ApiProperty() to: string;
  @ApiProperty() days: number;
  @ApiProperty({ type: [TrendDayDto] }) trend: TrendDayDto[];
  @ApiProperty({ type: RenewalStatsDto }) renewal: RenewalStatsDto;
  @ApiProperty({ type: ActivationStatsDto }) activation: ActivationStatsDto;
  @ApiProperty({ type: AftersalesRateDto }) aftersales: AftersalesRateDto;
  @ApiProperty({ type: StaffPerfDto }) staff: StaffPerfDto;
  @ApiProperty({ type: LtvStatsDto }) ltv: LtvStatsDto;
  @ApiProperty({ type: [AgentPerfDto], description: '代理业绩（区间内）' }) agents: AgentPerfDto[];
  @ApiProperty({ type: SegmentSnapshotDto }) segments: SegmentSnapshotDto;
}

const SOURCE_LABELS: Record<string, string> = Object.fromEntries(
  CUSTOMER_SOURCES.map((s) => [s.value, s.label]),
);

const ratio = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);
const avg = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
const minutes = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 60_000;

function tally<K, V>(map: Map<K, V>, key: K, init: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = init();
    map.set(key, v);
  }
  return v;
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(user: AuthUser, q: AnalyticsQueryDto, now = new Date()): Promise<AnalyticsDto> {
    const days = q.days ?? 30;
    const start = addDays(startOfLocalDay(now), -(days - 1));
    const range = { gte: start, lte: now };
    const scope = scopeWhere(user);
    // 履约任务按客户的负责人划范围；能看全部数据时不过滤
    const taskScope: Prisma.FulfillmentTaskWhereInput =
      Object.keys(scope).length > 0 ? { customer: scope } : {};
    const cost = canSeeCost(user);

    const [
      payments,
      refunds,
      paidOrders,
      newCustomers,
      doneTasks,
      tickets,
      resolvedTickets,
      activeSubscriptions,
      dueOrders,
      lifetimeOrders,
    ] = await Promise.all([
      this.prisma.payment.findMany({
        where: { receivedAt: range, order: scope },
        select: { amountCents: true, receivedAt: true },
      }),
      this.prisma.refund.findMany({
        where: { AND: [scope], status: 'PAID', paidAt: range },
        select: { amountCents: true, paidAt: true },
      }),
      this.prisma.order.findMany({
        where: { AND: [scope], paidAt: range },
        select: {
          kind: true,
          paidAt: true,
          ownerId: true,
          owner: { select: { displayName: true } },
          paidCents: true,
          refundedCents: true,
          feeCents: true,
          costCents: true,
          commissionCents: true,
          firstOrder: true,
          agent: { select: { id: true, no: true, name: true } },
        },
      }),
      this.prisma.customer.findMany({
        where: { AND: [scope], deletedAt: null, createdAt: range },
        select: { createdAt: true, ownerId: true, owner: { select: { displayName: true } } },
      }),
      this.prisma.fulfillmentTask.findMany({
        where: { AND: [taskScope], status: 'DONE', finishedAt: range },
        select: {
          type: true,
          createdAt: true,
          finishedAt: true,
          dueAt: true,
          assigneeId: true,
          assignee: { select: { displayName: true } },
        },
      }),
      this.prisma.ticket.findMany({
        where: { AND: [scope], createdAt: range },
        select: { type: true, createdAt: true, subscriptionId: true },
      }),
      this.prisma.ticket.findMany({
        where: { AND: [scope], resolvedAt: range },
        select: {
          createdAt: true,
          resolvedAt: true,
          escalatedAt: true,
          assigneeId: true,
          assignee: { select: { displayName: true } },
        },
      }),
      this.prisma.subscription.count({
        where: { AND: [scope], startAt: { lte: now }, endAt: { gte: start } },
      }),
      // 服务期在区间内结束的订单（已退款终止的不算）
      this.prisma.order.findMany({
        where: {
          AND: [scope],
          status: 'COMPLETED',
          subscriptionId: { not: null },
          periodEndAt: range,
          refunds: { none: { status: 'PAID', terminate: true } },
        },
        select: {
          createdAt: true,
          planName: true,
          subscription: {
            select: {
              orders: {
                where: { kind: 'RENEWAL', status: { in: ['FULFILLING', 'COMPLETED'] } },
                select: { createdAt: true },
              },
            },
          },
        },
      }),
      this.prisma.order.findMany({
        where: { AND: [scope], paidAt: { not: null } },
        select: {
          customerId: true,
          paidAt: true,
          paidCents: true,
          refundedCents: true,
          feeCents: true,
          costCents: true,
          commissionCents: true,
        },
      }),
    ]);

    // —— 趋势 ——
    const trend = new Map<string, TrendDayDto>();
    for (let i = 0; i < days; i++) {
      const date = localDateKey(addDays(start, i));
      trend.set(date, {
        date,
        receivedCents: 0,
        refundedCents: 0,
        paidOrders: 0,
        renewalOrders: 0,
        newCustomers: 0,
        activations: 0,
        tickets: 0,
      });
    }
    const day = (at: Date) => trend.get(localDateKey(at));
    for (const p of payments) {
      const d = day(p.receivedAt);
      if (d) d.receivedCents += p.amountCents;
    }
    for (const f of refunds) {
      const d = day(f.paidAt!);
      if (d) d.refundedCents += f.amountCents;
    }
    for (const o of paidOrders) {
      const d = day(o.paidAt!);
      if (!d) continue;
      d.paidOrders += 1;
      if (o.kind === 'RENEWAL') d.renewalOrders += 1;
    }
    for (const c of newCustomers) {
      const d = day(c.createdAt);
      if (d) d.newCustomers += 1;
    }
    for (const t of doneTasks) {
      const d = t.type === 'ACTIVATE' ? day(t.finishedAt!) : undefined;
      if (d) d.activations += 1;
    }
    for (const t of tickets) {
      const d = day(t.createdAt);
      if (d) d.tickets += 1;
    }

    // —— 续费率 ——
    const plans = new Map<string, RenewalGroupDto>();
    let due = 0;
    let renewed = 0;
    for (const o of dueOrders) {
      const ok = (o.subscription?.orders ?? []).some(
        (r) => r.createdAt.getTime() > o.createdAt.getTime(),
      );
      const g = tally(plans, o.planName, () => ({
        key: o.planName,
        label: o.planName,
        due: 0,
        renewed: 0,
        rate: null,
      }));
      g.due += 1;
      due += 1;
      if (ok) {
        g.renewed += 1;
        renewed += 1;
      }
    }
    for (const g of plans.values()) g.rate = ratio(g.renewed, g.due);

    // —— 开通时效 ——
    const activations = doneTasks.filter((t) => t.type === 'ACTIVATE');
    const activationMinutes = activations.map((t) => minutes(t.createdAt, t.finishedAt!));
    const onTime = (t: { finishedAt: Date | null; dueAt: Date }) =>
      t.finishedAt!.getTime() <= t.dueAt.getTime();
    const activationOnTime = activations.filter(onTime).length;

    // —— 售后率 ——
    const byType = new Map<string, number>(TICKET_TYPES.map((t) => [t, 0]));
    for (const t of tickets) byType.set(t.type, (byType.get(t.type) ?? 0) + 1);
    const subsWithTickets = new Set(tickets.map((t) => t.subscriptionId).filter(Boolean)).size;
    const received = payments.reduce((n, p) => n + p.amountCents, 0);
    const refunded = refunds.reduce((n, f) => n + f.amountCents, 0);
    const resolveHours = resolvedTickets.map((t) => minutes(t.createdAt, t.resolvedAt!) / 60);

    // —— 员工业绩 ——
    const sales = new Map<string, SalesPerfDto>();
    const salesRow = (id: string, name: string) =>
      tally(sales, id, () => ({
        userId: id,
        name,
        paidOrders: 0,
        renewalOrders: 0,
        paidCents: 0,
        marginCents: cost ? 0 : null,
        newCustomers: 0,
      }));
    for (const o of paidOrders) {
      const s = salesRow(o.ownerId, o.owner.displayName);
      s.paidOrders += 1;
      if (o.kind === 'RENEWAL') s.renewalOrders += 1;
      s.paidCents += o.paidCents;
      if (s.marginCents !== null) s.marginCents += orderMargin(o);
    }
    for (const c of newCustomers) salesRow(c.ownerId, c.owner.displayName).newCustomers += 1;

    const fulfillers = new Map<
      string,
      { name: string; done: number; onTime: number; activationMinutes: number[] }
    >();
    for (const t of doneTasks) {
      if (!t.assigneeId || !t.assignee) continue;
      const f = tally(fulfillers, t.assigneeId, () => ({
        name: t.assignee!.displayName,
        done: 0,
        onTime: 0,
        activationMinutes: [],
      }));
      f.done += 1;
      if (onTime(t)) f.onTime += 1;
      if (t.type === 'ACTIVATE') f.activationMinutes.push(minutes(t.createdAt, t.finishedAt!));
    }

    const handlers = new Map<string, { name: string; hours: number[]; escalated: number }>();
    for (const t of resolvedTickets) {
      if (!t.assigneeId || !t.assignee) continue;
      const h = tally(handlers, t.assigneeId, () => ({
        name: t.assignee!.displayName,
        hours: [],
        escalated: 0,
      }));
      h.hours.push(minutes(t.createdAt, t.resolvedAt!) / 60);
      if (t.escalatedAt) h.escalated += 1;
    }

    // —— 客户价值（全部历史） ——
    const customers = new Map<
      string,
      { orders: number; net: number; margin: number; first: Date; last: Date }
    >();
    for (const o of lifetimeOrders) {
      const c = tally(customers, o.customerId, () => ({
        orders: 0,
        net: 0,
        margin: 0,
        first: o.paidAt!,
        last: o.paidAt!,
      }));
      c.orders += 1;
      c.net += o.paidCents - o.refundedCents;
      c.margin += orderMargin(o);
      if (o.paidAt! < c.first) c.first = o.paidAt!;
      if (o.paidAt! > c.last) c.last = o.paidAt!;
    }
    const ranked = [...customers.entries()].sort((a, b) => b[1].net - a[1].net);
    const sources = await this.prisma.customer.findMany({
      where: { id: { in: [...customers.keys()] } },
      select: { ...customerBriefSelect, source: true },
    });
    const customerInfo = new Map(sources.map((c) => [c.id, c]));
    const bySource = new Map<string, { customers: number; net: number }>();
    for (const [id, c] of customers) {
      const source = customerInfo.get(id)?.source ?? 'other';
      const s = tally(bySource, source, () => ({ customers: 0, net: 0 }));
      s.customers += 1;
      s.net += c.net;
    }
    const all = [...customers.values()];

    // —— 代理业绩（区间内） ——
    const agents = new Map<string, AgentPerfDto>();
    const agentRow = (a: { id: string; no: number; name: string }) =>
      tally(agents, a.id, () => ({
        agentId: a.id,
        code: displayNo('A', a.no),
        name: a.name,
        newCustomers: 0,
        paidOrders: 0,
        firstOrders: 0,
        salesCents: 0,
        commissionCents: 0,
      }));
    for (const o of paidOrders) {
      if (!o.agent) continue;
      const row = agentRow(o.agent);
      row.paidOrders += 1;
      if (o.firstOrder) row.firstOrders += 1;
      row.salesCents += o.paidCents - o.refundedCents;
      row.commissionCents += o.commissionCents;
    }
    const [bound, stageGroups, lostGroups] = await Promise.all([
      this.prisma.customer.findMany({
        where: { AND: [scope], deletedAt: null, agentBoundAt: range, agentId: { not: null } },
        select: { agent: { select: { id: true, no: true, name: true } } },
      }),
      this.prisma.customer.groupBy({
        by: ['stage'],
        where: visibleCustomers(user),
        _count: { _all: true },
      }),
      this.prisma.customer.groupBy({
        by: ['lostReason'],
        where: { ...visibleCustomers(user), stage: { in: ['DORMANT', 'CHURNED'] } },
        _count: { _all: true },
      }),
    ]);
    for (const c of bound) if (c.agent) agentRow(c.agent).newCustomers += 1;
    const stageCount = new Map(stageGroups.map((g) => [g.stage, g._count._all]));

    return {
      from: localDateKey(start),
      to: localDateKey(now),
      days,
      trend: [...trend.values()],
      renewal: {
        key: 'all',
        label: '全部',
        due,
        renewed,
        rate: ratio(renewed, due),
        byPlan: [...plans.values()].sort((a, b) => b.due - a.due),
      },
      activation: {
        done: activations.length,
        onTime: activationOnTime,
        onTimeRate: ratio(activationOnTime, activations.length),
        avgMinutes: avg(activationMinutes),
        medianMinutes: median(activationMinutes),
      },
      aftersales: {
        tickets: tickets.length,
        subscriptionsWithTickets: subsWithTickets,
        activeSubscriptions,
        ticketRate: ratio(subsWithTickets, activeSubscriptions),
        refundedCents: refunded,
        receivedCents: received,
        refundRate: ratio(refunded, received),
        resolved: resolvedTickets.length,
        avgResolveHours: avg(resolveHours),
        onTimeRate: ratio(
          resolvedTickets.filter((t) => !t.escalatedAt).length,
          resolvedTickets.length,
        ),
        byType: [...byType.entries()].map(([type, count]) => ({ type: type as TicketType, count })),
      },
      staff: {
        sales: [...sales.values()].sort((a, b) => b.paidCents - a.paidCents),
        fulfillment: [...fulfillers.entries()]
          .map(([userId, f]) => ({
            userId,
            name: f.name,
            done: f.done,
            onTimeRate: ratio(f.onTime, f.done),
            activations: f.activationMinutes.length,
            avgActivationMinutes: avg(f.activationMinutes),
          }))
          .sort((a, b) => b.done - a.done),
        aftersales: [...handlers.entries()]
          .map(([userId, h]) => ({
            userId,
            name: h.name,
            resolved: h.hours.length,
            avgHours: avg(h.hours),
            escalated: h.escalated,
          }))
          .sort((a, b) => b.resolved - a.resolved),
      },
      ltv: {
        payingCustomers: all.length,
        repeatCustomers: all.filter((c) => c.orders >= 2).length,
        avgNetCents: avg(all.map((c) => c.net)),
        avgMarginCents: cost ? avg(all.map((c) => c.margin)) : null,
        avgOrders: avg(all.map((c) => c.orders)),
        bySource: [...bySource.entries()]
          .map(([source, s]) => ({
            source,
            label: SOURCE_LABELS[source] ?? source,
            customers: s.customers,
            avgNetCents: Math.round(s.net / s.customers),
          }))
          .sort((a, b) => b.customers - a.customers),
        top: ranked.slice(0, 10).flatMap(([id, c]) => {
          const info = customerInfo.get(id);
          if (!info) return [];
          return [
            {
              customer: toCustomerBrief(info),
              orders: c.orders,
              netCents: c.net,
              marginCents: cost ? c.margin : null,
              firstPaidAt: c.first,
              lastPaidAt: c.last,
            },
          ];
        }),
      },
      agents: [...agents.values()].sort(
        (a, b) => b.salesCents - a.salesCents || b.newCustomers - a.newCustomers,
      ),
      segments: {
        stages: CUSTOMER_STAGES.map((stage) => ({ stage, count: stageCount.get(stage) ?? 0 })),
        lostReasons: lostGroups
          .map((g) => ({ reason: g.lostReason, count: g._count._all }))
          .sort((a, b) => b.count - a.count),
      },
    };
  }
}

@ApiTags('数据看板')
@ApiBearerAuth()
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  @RequirePermissions('report:read')
  @ApiOperation({
    summary: '经营数据：趋势、续费率、开通时效、售后率、员工业绩、客户价值、代理业绩、客户分层',
  })
  @ApiOkResponse({ type: AnalyticsDto })
  overview(@CurrentUser() user: AuthUser, @Query() q: AnalyticsQueryDto): Promise<AnalyticsDto> {
    return this.analytics.overview(user, q);
  }
}

@Module({
  providers: [AnalyticsService],
  controllers: [AnalyticsController],
})
export class AnalyticsModule {}
