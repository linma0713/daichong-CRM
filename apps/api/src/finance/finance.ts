import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Matches } from 'class-validator';
import type { Prisma } from '@prisma/client';
import {
  COST_KIND_LABELS,
  CUSTOMER_SOURCES,
  RECEIPT_METHODS,
  displayNo,
  formatCents,
  type CostKind,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, RequirePermissions } from '../auth/decorators';
import type { AuthUser } from '../common/auth-user';
import { CustomerBriefDto, customerBriefSelect } from '../common/briefs';
import { addDays, localDateKey, parseLocalDate } from '../common/dates';
import { badRequest } from '../common/errors';
import { productName } from '../catalog/catalog';
import { orderMargin, toCustomerBrief, visibleOrders } from '../orders/orders';
import { visibleRefunds } from '../aftersales/aftersales';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 366;
const JOURNAL_LIMIT = 5000;

export class DateRangeQueryDto {
  @ApiProperty({ example: '2026-11-01', description: '开始日期（北京时间，含当天）' })
  @Matches(DATE_RE, { message: '开始日期格式应为 YYYY-MM-DD' })
  from: string;

  @ApiProperty({ example: '2026-11-30', description: '结束日期（北京时间，含当天）' })
  @Matches(DATE_RE, { message: '结束日期格式应为 YYYY-MM-DD' })
  to: string;
}

export interface LocalRange {
  start: Date;
  /** 结束日期次日 0 点（不含） */
  end: Date;
  days: string[];
}

/** 北京时间日期区间 → [start, end)，并列出每一天 */
export function parseRange(q: { from: string; to: string }): LocalRange {
  const start = parseLocalDate(q.from);
  const last = parseLocalDate(q.to);
  if (!start || !last) throw badRequest('日期无效');
  if (last.getTime() < start.getTime()) throw badRequest('结束日期不能早于开始日期');
  const count = Math.round((last.getTime() - start.getTime()) / 86_400_000) + 1;
  if (count > MAX_DAYS) throw badRequest(`一次最多查 ${MAX_DAYS} 天`);
  return {
    start,
    end: addDays(last, 1),
    days: Array.from({ length: count }, (_, i) => localDateKey(addDays(start, i))),
  };
}

/** 现金口径的金额：收款、手续费、退款、成本、代理佣金 */
export class FinanceAmountsDto {
  @ApiProperty({ description: '收款（分）' }) receivedCents: number;
  @ApiProperty({ description: '收款笔数' }) paymentCount: number;
  @ApiProperty({ description: '收款手续费（分）' }) feeCents: number;
  @ApiProperty({ description: '退款出账（分）' }) refundedCents: number;
  @ApiProperty({ description: '退款笔数' }) refundCount: number;
  @ApiProperty({ description: '净收入 = 收款 − 退款 − 手续费' }) netCents: number;
  @ApiProperty({ description: '当期发生的成本（上游扣费、成品号等）' }) costCents: number;
  @ApiProperty({
    description:
      '代理佣金（分）：佣金对账单结清当天按佣金合计计入（代理代收的款已经算在收款里，打款时只付差额）',
  })
  commissionCents: number;
  @ApiProperty({ description: '毛利 = 净收入 − 成本 − 代理佣金' }) profitCents: number;
}

export class FinanceTotalsDto extends FinanceAmountsDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description: '付款资源入库支出（买卡、充值的实际花费）。只对能看全部数据的人返回',
  })
  resourceSpendCents: number | null;
}

export class FinanceDayDto extends FinanceAmountsDto {
  @ApiProperty({ example: '2026-11-20' }) date: string;
}

export class FinanceMethodDto {
  @ApiProperty({ example: 'wechat' }) method: string;
  @ApiProperty({ example: '微信' }) label: string;
  @ApiProperty() receivedCents: number;
  @ApiProperty() paymentCount: number;
  @ApiProperty() feeCents: number;
  @ApiProperty() refundedCents: number;
  @ApiProperty() refundCount: number;
  @ApiProperty({ description: '到账净额 = 收款 − 手续费 − 退款' }) netCents: number;
}

/** 按订单口径的分组：区间内收齐款的订单，截至目前的退款和成本 */
export class FinanceGroupDto {
  @ApiProperty() key: string;
  @ApiProperty() label: string;
  @ApiProperty() orderCount: number;
  @ApiProperty() paidCents: number;
  @ApiProperty() refundedCents: number;
  @ApiProperty() feeCents: number;
  @ApiProperty() costCents: number;
  @ApiProperty({ description: '订单上的代理佣金（不含已作废）' }) commissionCents: number;
  @ApiProperty({ description: '毛利 = 收款 − 退款 − 手续费 − 成本 − 代理佣金' })
  marginCents: number;
}

export class FinanceReportDto {
  @ApiProperty() from: string;
  @ApiProperty() to: string;
  @ApiProperty({ type: FinanceTotalsDto }) totals: FinanceTotalsDto;
  @ApiProperty({ type: [FinanceDayDto], description: '每日对账' }) days: FinanceDayDto[];
  @ApiProperty({ type: [FinanceMethodDto], description: '按收款方式' })
  methods: FinanceMethodDto[];
  @ApiProperty({ type: [FinanceGroupDto] }) byProduct: FinanceGroupDto[];
  @ApiProperty({ type: [FinanceGroupDto], description: '按负责客服' }) byStaff: FinanceGroupDto[];
  @ApiProperty({ type: [FinanceGroupDto], description: '按客户来源' })
  bySource: FinanceGroupDto[];
  @ApiProperty({ type: [FinanceGroupDto], description: '按代理（直客单独一行），也是代理业绩' })
  byAgent: FinanceGroupDto[];
}

export class JournalEntryDto {
  @ApiProperty({ enum: ['payment', 'refund', 'cost', 'commission'] })
  kind: 'payment' | 'refund' | 'cost' | 'commission';
  @ApiProperty() id: string;
  @ApiProperty() at: Date;
  @ApiProperty({ type: String, nullable: true }) orderId: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'D00012' }) orderCode: string | null;
  @ApiProperty({ type: CustomerBriefDto, nullable: true }) customer: CustomerBriefDto | null;
  @ApiProperty({ description: '收款 / 退款方式、成本类型，或「代理佣金」' }) category: string;
  @ApiProperty({ description: '金额（分），收款为正，退款、成本和代理佣金为负' })
  amountCents: number;
  @ApiProperty({ description: '手续费（分），仅收款' }) feeCents: number;
  @ApiProperty({ type: String, nullable: true, description: '单号 / 退款编号 / 说明' })
  reference: string | null;
  @ApiProperty({ type: String, nullable: true }) userName: string | null;
}

export class JournalDto {
  @ApiProperty({ type: [JournalEntryDto] }) items: JournalEntryDto[];
  @ApiProperty({ description: `超过 ${JOURNAL_LIMIT} 条时只返回最早的部分` }) truncated: boolean;
}

const METHOD_LABELS: Record<string, string> = Object.fromEntries(
  RECEIPT_METHODS.map((m) => [m.value, m.label]),
);
const SOURCE_LABELS: Record<string, string> = Object.fromEntries(
  CUSTOMER_SOURCES.map((s) => [s.value, s.label]),
);

function emptyAmounts(): FinanceAmountsDto {
  return {
    receivedCents: 0,
    paymentCount: 0,
    feeCents: 0,
    refundedCents: 0,
    refundCount: 0,
    netCents: 0,
    costCents: 0,
    commissionCents: 0,
    profitCents: 0,
  };
}

function settle<T extends FinanceAmountsDto>(a: T): T {
  a.netCents = a.receivedCents - a.refundedCents - a.feeCents;
  a.profitCents = a.netCents - a.costCents - a.commissionCents;
  return a;
}

/** 有全部数据权限时成本不按订单过滤（没归到订单的成本也算进去） */
function seesAll(user: AuthUser): boolean {
  return user.dataScope === 'ALL';
}

@Injectable()
export class FinanceService {
  constructor(private readonly prisma: PrismaService) {}

  private inRange(r: LocalRange): Prisma.DateTimeFilter {
    return { gte: r.start, lt: r.end };
  }

  private costWhere(user: AuthUser, r: LocalRange): Prisma.CostEntryWhereInput {
    return {
      createdAt: this.inRange(r),
      ...(seesAll(user) ? {} : { order: visibleOrders(user) }),
    };
  }

  /** 区间内结清的佣金对账单里、看得到的订单上的佣金明细 */
  private paidCommissionWhere(user: AuthUser, r: LocalRange): Prisma.CommissionWhereInput {
    return {
      status: { not: 'VOID' },
      statement: { status: 'PAID', paidAt: this.inRange(r) },
      order: visibleOrders(user),
    };
  }

  async report(user: AuthUser, q: DateRangeQueryDto): Promise<FinanceReportDto> {
    const r = parseRange(q);
    const [payments, refunds, costs, topUps, orders, commissions] = await Promise.all([
      this.prisma.payment.findMany({
        where: { receivedAt: this.inRange(r), order: visibleOrders(user) },
        select: { amountCents: true, feeCents: true, method: true, receivedAt: true },
      }),
      this.prisma.refund.findMany({
        where: { AND: [visibleRefunds(user)], status: 'PAID', paidAt: this.inRange(r) },
        select: { amountCents: true, method: true, paidAt: true },
      }),
      this.prisma.costEntry.findMany({
        where: this.costWhere(user, r),
        select: { amountCents: true, createdAt: true },
      }),
      seesAll(user)
        ? this.prisma.resourceTransaction.aggregate({
            where: { type: 'TOP_UP', createdAt: this.inRange(r) },
            _sum: { cnyCents: true },
          })
        : null,
      this.prisma.order.findMany({
        where: { AND: [visibleOrders(user)], paidAt: this.inRange(r) },
        select: {
          paidCents: true,
          refundedCents: true,
          feeCents: true,
          costCents: true,
          commissionCents: true,
          productId: true,
          planName: true,
          termMonths: true,
          fulfillmentType: true,
          ownerId: true,
          owner: { select: { displayName: true } },
          customer: { select: { source: true } },
          agent: { select: { id: true, no: true, name: true } },
        },
      }),
      this.prisma.commission.findMany({
        where: this.paidCommissionWhere(user, r),
        select: { amountCents: true, statement: { select: { paidAt: true } } },
      }),
    ]);

    const totals: FinanceTotalsDto = {
      ...emptyAmounts(),
      resourceSpendCents: topUps ? (topUps._sum.cnyCents ?? 0) : null,
    };
    const days = new Map<string, FinanceDayDto>(
      r.days.map((date) => [date, { date, ...emptyAmounts() }]),
    );
    const methods = new Map<string, FinanceMethodDto>();
    const method = (m: string | null): FinanceMethodDto => {
      const key = m ?? 'other';
      let row = methods.get(key);
      if (!row) {
        row = {
          method: key,
          label: METHOD_LABELS[key] ?? key,
          receivedCents: 0,
          paymentCount: 0,
          feeCents: 0,
          refundedCents: 0,
          refundCount: 0,
          netCents: 0,
        };
        methods.set(key, row);
      }
      return row;
    };
    const day = (at: Date) => days.get(localDateKey(at));

    for (const p of payments) {
      for (const a of [totals, day(p.receivedAt)]) {
        if (!a) continue;
        a.receivedCents += p.amountCents;
        a.paymentCount += 1;
        a.feeCents += p.feeCents;
      }
      const m = method(p.method);
      m.receivedCents += p.amountCents;
      m.paymentCount += 1;
      m.feeCents += p.feeCents;
    }
    for (const f of refunds) {
      for (const a of [totals, day(f.paidAt!)]) {
        if (!a) continue;
        a.refundedCents += f.amountCents;
        a.refundCount += 1;
      }
      const m = method(f.method);
      m.refundedCents += f.amountCents;
      m.refundCount += 1;
    }
    for (const c of costs) {
      for (const a of [totals, day(c.createdAt)]) {
        if (a) a.costCents += c.amountCents;
      }
    }
    for (const c of commissions) {
      for (const a of [totals, day(c.statement!.paidAt!)]) {
        if (a) a.commissionCents += c.amountCents;
      }
    }
    settle(totals);
    for (const d of days.values()) settle(d);
    for (const m of methods.values()) m.netCents = m.receivedCents - m.feeCents - m.refundedCents;

    const group = (keyOf: (o: (typeof orders)[number]) => [string, string]) => {
      const rows = new Map<string, FinanceGroupDto>();
      for (const o of orders) {
        const [key, label] = keyOf(o);
        let row = rows.get(key);
        if (!row) {
          row = {
            key,
            label,
            orderCount: 0,
            paidCents: 0,
            refundedCents: 0,
            feeCents: 0,
            costCents: 0,
            commissionCents: 0,
            marginCents: 0,
          };
          rows.set(key, row);
        }
        row.orderCount += 1;
        row.paidCents += o.paidCents;
        row.refundedCents += o.refundedCents;
        row.feeCents += o.feeCents;
        row.costCents += o.costCents;
        row.commissionCents += o.commissionCents;
        row.marginCents += orderMargin(o);
      }
      return [...rows.values()].sort((a, b) => b.paidCents - a.paidCents);
    };

    const methodOrder = RECEIPT_METHODS.map((m) => m.value as string);
    return {
      from: q.from,
      to: q.to,
      totals,
      days: [...days.values()],
      methods: [...methods.values()].sort(
        (a, b) => methodOrder.indexOf(a.method) - methodOrder.indexOf(b.method),
      ),
      byProduct: group((o) => [
        o.productId,
        productName(o.planName, o.termMonths, o.fulfillmentType),
      ]),
      byStaff: group((o) => [o.ownerId, o.owner.displayName]),
      bySource: group((o) => [
        o.customer.source,
        SOURCE_LABELS[o.customer.source] ?? o.customer.source,
      ]),
      byAgent: group((o) =>
        o.agent ? [o.agent.id, `${o.agent.name}（${displayNo('A', o.agent.no)}）`] : ['', '直客'],
      ),
    };
  }

  /** 收支明细：收款、退款出账、成本、代理佣金打款，按时间排 */
  async journal(user: AuthUser, q: DateRangeQueryDto): Promise<JournalDto> {
    const r = parseRange(q);
    const orderSelect = { id: true, no: true, customer: { select: customerBriefSelect } };
    const take = JOURNAL_LIMIT + 1;
    const [payments, refunds, costs, commissions] = await Promise.all([
      this.prisma.payment.findMany({
        where: { receivedAt: this.inRange(r), order: visibleOrders(user) },
        include: { order: { select: orderSelect }, confirmedBy: { select: { displayName: true } } },
        orderBy: { receivedAt: 'asc' },
        take,
      }),
      this.prisma.refund.findMany({
        where: { AND: [visibleRefunds(user)], status: 'PAID', paidAt: this.inRange(r) },
        include: { order: { select: orderSelect }, approvedBy: { select: { displayName: true } } },
        orderBy: { paidAt: 'asc' },
        take,
      }),
      this.prisma.costEntry.findMany({
        where: this.costWhere(user, r),
        include: { order: { select: orderSelect }, user: { select: { displayName: true } } },
        orderBy: { createdAt: 'asc' },
        take,
      }),
      this.prisma.commission.findMany({
        where: this.paidCommissionWhere(user, r),
        select: {
          amountCents: true,
          statement: {
            select: {
              id: true,
              no: true,
              paidAt: true,
              payMethod: true,
              payReference: true,
              collectedCents: true,
              agent: { select: { name: true } },
              paidBy: { select: { displayName: true } },
            },
          },
        },
      }),
    ]);
    // 佣金按对账单合成一条
    const statements = new Map<
      string,
      { s: NonNullable<(typeof commissions)[number]['statement']>; cents: number }
    >();
    for (const c of commissions) {
      const s = c.statement!;
      const row = statements.get(s.id) ?? { s, cents: 0 };
      row.cents += c.amountCents;
      statements.set(s.id, row);
    }
    type OrderRef = { id: string; no: number; customer: Parameters<typeof toCustomerBrief>[0] };
    const ref = (o: OrderRef | null) => ({
      orderId: o?.id ?? null,
      orderCode: o ? displayNo('D', o.no) : null,
      customer: o ? toCustomerBrief(o.customer) : null,
    });
    const items: JournalEntryDto[] = [
      ...payments.map((p): JournalEntryDto => ({
        kind: 'payment',
        id: p.id,
        at: p.receivedAt,
        ...ref(p.order),
        category: METHOD_LABELS[p.method] ?? p.method,
        amountCents: p.amountCents,
        feeCents: p.feeCents,
        reference: p.reference,
        userName: p.confirmedBy.displayName,
      })),
      ...refunds.map((f): JournalEntryDto => ({
        kind: 'refund',
        id: f.id,
        at: f.paidAt!,
        ...ref(f.order),
        category: f.method ? (METHOD_LABELS[f.method] ?? f.method) : '退款',
        amountCents: -f.amountCents,
        feeCents: 0,
        reference: [displayNo('K', f.no), f.reference].filter(Boolean).join(' · '),
        userName: f.approvedBy?.displayName ?? null,
      })),
      ...costs.map((c): JournalEntryDto => ({
        kind: 'cost',
        id: c.id,
        at: c.createdAt,
        ...ref(c.order),
        category: COST_KIND_LABELS[c.kind as CostKind] ?? c.kind,
        amountCents: -c.amountCents,
        feeCents: 0,
        reference: c.note,
        userName: c.user.displayName,
      })),
      ...[...statements.values()].map(({ s, cents }): JournalEntryDto => ({
        kind: 'commission',
        id: s.id,
        at: s.paidAt!,
        orderId: null,
        orderCode: null,
        customer: null,
        category: '代理佣金',
        amountCents: -cents,
        feeCents: 0,
        reference: [
          displayNo('J', s.no),
          s.agent.name,
          s.collectedCents > 0 ? `代收抵扣 ${formatCents(s.collectedCents)}` : null,
          s.payMethod ? (METHOD_LABELS[s.payMethod] ?? s.payMethod) : null,
          s.payReference,
        ]
          .filter(Boolean)
          .join(' · '),
        userName: s.paidBy?.displayName ?? null,
      })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());
    const truncated =
      items.length > JOURNAL_LIMIT ||
      [payments, refunds, costs].some((list) => list.length > JOURNAL_LIMIT);
    return { items: items.slice(0, JOURNAL_LIMIT), truncated };
  }
}

@ApiTags('财务')
@ApiBearerAuth()
@Controller('finance')
export class FinanceController {
  constructor(private readonly finance: FinanceService) {}

  @Get('report')
  @RequirePermissions('finance:read')
  @ApiOperation({
    summary: '财务对账：现金口径汇总、每日对账、按收款方式、按商品 / 客服 / 来源 / 代理',
  })
  @ApiOkResponse({ type: FinanceReportDto })
  report(@CurrentUser() user: AuthUser, @Query() q: DateRangeQueryDto): Promise<FinanceReportDto> {
    return this.finance.report(user, q);
  }

  @Get('journal')
  @RequirePermissions('finance:read')
  @ApiOperation({ summary: '收支明细（收款、退款出账、成本、代理佣金），用于导出对账' })
  @ApiOkResponse({ type: JournalDto })
  journal(@CurrentUser() user: AuthUser, @Query() q: DateRangeQueryDto): Promise<JournalDto> {
    return this.finance.journal(user, q);
  }
}

@Module({
  providers: [FinanceService],
  controllers: [FinanceController],
})
export class FinanceModule {}
