import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { Prisma, StatementStatus } from '@prisma/client';
import {
  AGENT_COLLECTED,
  PAYMENT_METHOD_VALUES,
  STATEMENT_STATUSES,
  displayNo,
  formatCents,
  parseNo,
  shiftMonth,
  type PaymentMethod,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { Audit, CurrentUser, RequireAnyPermission, RequirePermissions } from '../auth/decorators';
import type { AuthUser } from '../common/auth-user';
import {
  AgentBriefDto,
  CustomerBriefDto,
  UserBriefDto,
  agentBriefSelect,
  customerBriefSelect,
  toAgentBrief,
  userBriefSelect,
} from '../common/briefs';
import { localDateKey, parseLocalDate } from '../common/dates';
import { badRequest, notFound } from '../common/errors';
import { NotifyService } from '../notify/notify';
import { PageQueryDto, skipTake } from '../common/pagination';
import { toCustomerBrief } from '../orders/orders';
import {
  COMMISSION_VIEW_PERMISSIONS,
  CommissionDto,
  CommissionRefDto,
  CommissionsController,
  CommissionsService,
  commissionInclude,
  toCommissionDto,
} from './commissions';

type Tx = Prisma.TransactionClient;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** 记录每月自动出单进度的设置项（不在业务设置页面显示） */
export const AUTO_MONTH_KEY = 'commissionStatementAutoMonth';

/** 北京时间的月份 YYYY-MM */
export function localMonthKey(date: Date): string {
  return localDateKey(date).slice(0, 7);
}

/** 对账月份 → [当月 1 日 0 点, 次月 1 日 0 点)（北京时间） */
export function monthRange(month: string): { start: Date; end: Date } {
  const start = parseLocalDate(`${month}-01`);
  const end = parseLocalDate(`${shiftMonth(month, 1)}-01`);
  if (!MONTH_RE.test(month) || !start || !end) throw badRequest('月份格式应为 YYYY-MM');
  return { start, end };
}

// ─────────────── DTO ───────────────

export class StatementDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'J00001' }) code: string;
  @ApiProperty({ type: AgentBriefDto }) agent: AgentBriefDto;
  @ApiProperty({ example: '2026-11', description: '对账月份（北京时间）' }) month: string;
  @ApiProperty({ description: '收录截止时间：这之前变成可结算的佣金和代收款' }) cutoffAt: Date;
  @ApiProperty({ enum: STATEMENT_STATUSES, enumName: 'StatementStatus' })
  status: StatementStatus;
  @ApiProperty({ description: '佣金合计（分，含退款扣回）。待确认时按当前明细实时算' })
  commissionCents: number;
  @ApiProperty({ description: '代理代收的款（分），从佣金里抵扣' }) collectedCents: number;
  @ApiProperty({ description: '应付代理（分）= 佣金 − 代收；负数表示代理要补交给我们' })
  payableCents: number;
  @ApiProperty({ description: '佣金明细条数' }) commissionCount: number;
  @ApiProperty({ description: '代收款笔数' }) paymentCount: number;
  @ApiProperty({ type: UserBriefDto, nullable: true }) confirmedBy: UserBriefDto | null;
  @ApiProperty({ type: String, nullable: true }) confirmedAt: Date | null;
  @ApiProperty({ type: UserBriefDto, nullable: true }) paidBy: UserBriefDto | null;
  @ApiProperty({ type: String, nullable: true }) paidAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '打款方式（代理补交时是收款方式）；应付为 0 时为空',
  })
  payMethod: string | null;
  @ApiProperty({ type: String, nullable: true }) payReference: string | null;
  @ApiProperty({ type: UserBriefDto, nullable: true, description: '手动生成的人；自动生成为空' })
  createdBy: UserBriefDto | null;
  @ApiProperty({ type: String, nullable: true }) cancelledAt: Date | null;
  @ApiProperty({ type: String, nullable: true, description: '确认备注或作废原因' })
  note: string | null;
  @ApiProperty() createdAt: Date;
}

export class StatementPaymentDto {
  @ApiProperty() id: string;
  @ApiProperty({ type: CommissionRefDto }) order: CommissionRefDto;
  @ApiProperty({ type: CustomerBriefDto }) customer: CustomerBriefDto;
  @ApiProperty() amountCents: number;
  @ApiProperty() receivedAt: Date;
  @ApiProperty({ type: String, nullable: true }) reference: string | null;
}

export class AgentPayoutDto {
  @ApiProperty({ type: String, nullable: true }) method: string | null;
  @ApiProperty({ type: String, nullable: true }) account: string | null;
}

export class StatementDetailDto extends StatementDto {
  @ApiProperty({ type: AgentPayoutDto, description: '代理的收款方式和账号' })
  payout: AgentPayoutDto;
  @ApiProperty({ type: [CommissionDto] }) commissions: CommissionDto[];
  @ApiProperty({ type: [StatementPaymentDto], description: '代理代收、在这张单里抵扣的款' })
  payments: StatementPaymentDto[];
}

export class StatementQueryDto extends PageQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  agentId?: string;

  @ApiPropertyOptional({ enum: STATEMENT_STATUSES, enumName: 'StatementStatus' })
  @IsOptional()
  @IsIn(STATEMENT_STATUSES)
  status?: StatementStatus;

  @ApiPropertyOptional({ example: '2026-11' })
  @IsOptional()
  @Matches(MONTH_RE, { message: '月份格式应为 YYYY-MM' })
  month?: string;

  @ApiPropertyOptional({ description: '对账单编号' })
  @IsOptional()
  @IsString()
  keyword?: string;
}

export class StatementListDto {
  @ApiProperty({ type: [StatementDto] }) items: StatementDto[];
  @ApiProperty() total: number;
}

export class GenerateStatementsDto {
  @ApiProperty({ example: '2026-11', description: '对账月份；当月生成的收录到现在为止' })
  @Matches(MONTH_RE, { message: '月份格式应为 YYYY-MM' })
  month: string;

  @ApiPropertyOptional({ description: '只给这个代理生成；不填为全部有待结算佣金的代理' })
  @IsOptional()
  @IsString()
  agentId?: string;
}

export class GenerateResultDto {
  @ApiProperty() month: string;
  @ApiProperty({ description: '新生成的对账单数' }) created: number;
  @ApiProperty({ description: '已有草稿、补进新明细的对账单数' }) refreshed: number;
  @ApiProperty({
    description: '这个月已经确认 / 结清的代理数，新明细留到下个月',
  })
  skipped: number;
  @ApiProperty({ type: [StatementDto] }) items: StatementDto[];
}

export class ConfirmStatementDto {
  @ApiPropertyOptional({ description: '备注，比如和代理核对的情况' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class PayStatementDto {
  @ApiPropertyOptional({
    enum: PAYMENT_METHOD_VALUES,
    description: '打款方式；代理补交时是收款方式。应付为 0 时可以不填',
  })
  @IsOptional()
  @IsIn(PAYMENT_METHOD_VALUES)
  method?: PaymentMethod;

  @ApiPropertyOptional({ description: '转账单号或备注' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;

  @ApiPropertyOptional({ description: '打款时间，不填为现在' })
  @IsOptional()
  @IsDateString()
  paidAt?: string;
}

export class CancelStatementDto {
  @ApiProperty({ example: '金额核对有误，重新出单' })
  @IsString()
  @MinLength(1, { message: '请填写作废原因' })
  @MaxLength(500)
  reason: string;
}

// ─────────────── Service ───────────────

const statementInclude = {
  agent: { select: agentBriefSelect },
  confirmedBy: { select: userBriefSelect },
  paidBy: { select: userBriefSelect },
  createdBy: { select: userBriefSelect },
  _count: { select: { commissions: true, payments: true } },
} satisfies Prisma.CommissionStatementInclude;
type StatementRow = Prisma.CommissionStatementGetPayload<{ include: typeof statementInclude }>;

interface Live {
  commissionCents: number;
  collectedCents: number;
}

@Injectable()
export class StatementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notify: NotifyService,
  ) {}

  /** 待确认的单按当前明细实时算金额，其余用确认 / 作废时定下的金额 */
  private toDto(s: StatementRow, live?: Live): StatementDto {
    const draft = s.status === 'DRAFT';
    const commissionCents = draft ? (live?.commissionCents ?? 0) : s.commissionCents;
    const collectedCents = draft ? (live?.collectedCents ?? 0) : s.collectedCents;
    return {
      id: s.id,
      code: displayNo('J', s.no),
      agent: toAgentBrief(s.agent),
      month: s.month,
      cutoffAt: s.cutoffAt,
      status: s.status,
      commissionCents,
      collectedCents,
      payableCents: draft ? commissionCents - collectedCents : s.payableCents,
      commissionCount: s._count.commissions,
      paymentCount: s._count.payments,
      confirmedBy: s.confirmedBy,
      confirmedAt: s.confirmedAt,
      paidBy: s.paidBy,
      paidAt: s.paidAt,
      payMethod: s.payMethod,
      payReference: s.payReference,
      createdBy: s.createdBy,
      cancelledAt: s.cancelledAt,
      note: s.note,
      createdAt: s.createdAt,
    };
  }

  /** 一批对账单当前挂着的佣金合计（不含已作废）和代收合计 */
  private async live(db: Tx, ids: string[]): Promise<Map<string, Live>> {
    const map = new Map<string, Live>(
      ids.map((id) => [id, { commissionCents: 0, collectedCents: 0 }]),
    );
    if (ids.length === 0) return map;
    const [commissions, payments] = await Promise.all([
      db.commission.groupBy({
        by: ['statementId'],
        where: { statementId: { in: ids }, status: { not: 'VOID' } },
        _sum: { amountCents: true },
      }),
      db.payment.groupBy({
        by: ['statementId'],
        where: { statementId: { in: ids } },
        _sum: { amountCents: true },
      }),
    ]);
    for (const c of commissions) map.get(c.statementId!)!.commissionCents = c._sum.amountCents ?? 0;
    for (const p of payments) map.get(p.statementId!)!.collectedCents = p._sum.amountCents ?? 0;
    return map;
  }

  private async load(db: Tx, ids: string[]): Promise<StatementDto[]> {
    const rows = await db.commissionStatement.findMany({
      where: { id: { in: ids } },
      include: statementInclude,
    });
    const live = await this.live(
      db,
      rows.filter((r) => r.status === 'DRAFT').map((r) => r.id),
    );
    const byId = new Map(rows.map((r) => [r.id, this.toDto(r, live.get(r.id))]));
    return ids.map((id) => byId.get(id)!).filter(Boolean);
  }

  async list(q: StatementQueryDto): Promise<StatementListDto> {
    const no = parseNo(q.keyword, 'J');
    const where: Prisma.CommissionStatementWhereInput = {
      agentId: q.agentId,
      status: q.status,
      month: q.month,
      ...(q.keyword?.trim() ? { no: no ?? -1 } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.commissionStatement.findMany({
        where,
        include: statementInclude,
        orderBy: [{ month: 'desc' }, { no: 'desc' }],
        ...skipTake(q),
      }),
      this.prisma.commissionStatement.count({ where }),
    ]);
    const live = await this.live(
      this.prisma,
      rows.filter((r) => r.status === 'DRAFT').map((r) => r.id),
    );
    return { items: rows.map((r) => this.toDto(r, live.get(r.id))), total };
  }

  async get(id: string): Promise<StatementDetailDto> {
    const s = await this.prisma.commissionStatement.findUnique({
      where: { id },
      include: {
        ...statementInclude,
        agent: { select: { ...agentBriefSelect, payoutMethod: true, payoutAccount: true } },
        commissions: {
          include: commissionInclude,
          orderBy: [{ releasedAt: 'asc' }, { seq: 'asc' }],
        },
        payments: {
          include: {
            order: { select: { id: true, no: true, customer: { select: customerBriefSelect } } },
          },
          orderBy: { receivedAt: 'asc' },
        },
      },
    });
    if (!s) throw notFound('对账单');
    const live =
      s.status === 'DRAFT' ? (await this.live(this.prisma, [s.id])).get(s.id) : undefined;
    return {
      ...this.toDto(s, live),
      payout: { method: s.agent.payoutMethod, account: s.agent.payoutAccount },
      commissions: s.commissions.map(toCommissionDto),
      payments: s.payments.map((p) => ({
        id: p.id,
        order: { id: p.order.id, code: displayNo('D', p.order.no) },
        customer: toCustomerBrief(p.order.customer),
        amountCents: p.amountCents,
        receivedAt: p.receivedAt,
        reference: p.reference,
      })),
    };
  }

  /** 手动生成（或刷新草稿） */
  async generate(dto: GenerateStatementsDto, user: AuthUser): Promise<GenerateResultDto> {
    if (dto.agentId) {
      const agent = await this.prisma.agent.findUnique({ where: { id: dto.agentId } });
      if (!agent) throw notFound('代理');
    }
    return this.prisma.$transaction((tx) =>
      this.generateIn(tx, dto.month, { agentId: dto.agentId, userId: user.id }),
    );
  }

  /**
   * 给某个月出对账单：截止到月底（当月就是现在）之前变成可结算、还没进过对账单的佣金，
   * 加上代理代收、还没抵扣的款。这个月已有草稿的补进去；已经确认 / 结清的跳过，留到下个月。
   */
  async generateIn(
    tx: Tx,
    month: string,
    opts: { agentId?: string; userId?: string | null; now?: Date } = {},
  ): Promise<GenerateResultDto> {
    const now = opts.now ?? new Date();
    const { end } = monthRange(month);
    if (month > localMonthKey(now)) throw badRequest('还没到这个月，不能出对账单');
    const cutoffAt = end.getTime() < now.getTime() ? end : now;

    const commissionWhere = (agentId?: string): Prisma.CommissionWhereInput => ({
      agentId,
      status: 'RELEASABLE',
      statementId: null,
      releasedAt: { lt: cutoffAt },
    });
    const paymentWhere = (agentId?: string): Prisma.PaymentWhereInput => ({
      agentId: agentId ?? { not: null },
      method: AGENT_COLLECTED,
      statementId: null,
      receivedAt: { lt: cutoffAt },
    });

    const [fromCommissions, fromPayments, drafts] = await Promise.all([
      tx.commission.findMany({
        where: commissionWhere(opts.agentId),
        select: { agentId: true },
        distinct: ['agentId'],
      }),
      tx.payment.findMany({
        where: paymentWhere(opts.agentId),
        select: { agentId: true },
        distinct: ['agentId'],
      }),
      // 已有草稿的也刷新一下（明细可能被退款扣到作废）
      tx.commissionStatement.findMany({
        where: { month, status: 'DRAFT', agentId: opts.agentId },
        select: { agentId: true },
      }),
    ]);
    const agentIds = [
      ...new Set([
        ...fromCommissions.map((r) => r.agentId),
        ...fromPayments.map((r) => r.agentId!),
        ...drafts.map((r) => r.agentId),
      ]),
    ];

    const result: GenerateResultDto = { month, created: 0, refreshed: 0, skipped: 0, items: [] };
    const touched: string[] = [];
    for (const agentId of agentIds) {
      // 同一个代理同时只允许一个人出单
      await tx.$queryRaw`SELECT id FROM "Agent" WHERE id = ${agentId} FOR UPDATE`;
      const existing = await tx.commissionStatement.findFirst({
        where: { agentId, month, status: { not: 'CANCELLED' } },
        orderBy: { createdAt: 'desc' },
      });
      if (existing && existing.status !== 'DRAFT') {
        result.skipped++;
        continue;
      }
      // 退款扣到 0 的明细从草稿里拿掉
      if (existing) {
        await tx.commission.updateMany({
          where: { statementId: existing.id, status: 'VOID' },
          data: { statementId: null },
        });
      }
      const [pendingCommissions, pendingPayments] = await Promise.all([
        tx.commission.count({ where: commissionWhere(agentId) }),
        tx.payment.count({ where: paymentWhere(agentId) }),
      ]);
      if (!existing && pendingCommissions + pendingPayments === 0) continue;
      const statement = existing
        ? await tx.commissionStatement.update({ where: { id: existing.id }, data: { cutoffAt } })
        : await tx.commissionStatement.create({
            data: { agentId, month, cutoffAt, createdById: opts.userId ?? null },
          });
      await tx.commission.updateMany({
        where: commissionWhere(agentId),
        data: { statementId: statement.id },
      });
      await tx.payment.updateMany({
        where: paymentWhere(agentId),
        data: { statementId: statement.id },
      });
      if (existing) result.refreshed++;
      else result.created++;
      touched.push(statement.id);
    }
    result.items = await this.load(tx, touched);
    return result;
  }

  /** 上个月的对账单还没自动出过就出一次（巡检里调用，每月 1 号起生效） */
  async autoGenerate(tx: Tx, now = new Date()): Promise<number> {
    const month = shiftMonth(localMonthKey(now), -1);
    const row = await tx.setting.findUnique({ where: { key: AUTO_MONTH_KEY } });
    const done = typeof row?.value === 'string' ? row.value : null;
    if (done && done >= month) return 0;
    const r = await this.generateIn(tx, month, { userId: null, now });
    if (r.items.length > 0) {
      const payable = r.items.reduce((sum, i) => sum + i.payableCents, 0);
      await this.notify.emit(tx, {
        event: 'statement.generated',
        title: `${month} 佣金对账单已生成：${r.items.length} 位代理`,
        body: `应付代理合计 ${formatCents(payable)}（负数是代理要补交的代收款）\n请和代理核对后确认，再登记打款`,
        link: `/commissions?tab=statements`,
        toPermission: 'commission:settle',
      });
    }
    await tx.setting.upsert({
      where: { key: AUTO_MONTH_KEY },
      create: { key: AUTO_MONTH_KEY, value: month },
      update: { value: month },
    });
    return r.created + r.refreshed;
  }

  /** 锁住对账单和挂在上面的佣金行（退款扣减也会锁佣金行，两边不会交错） */
  private async lockStatement(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT id FROM "CommissionStatement" WHERE id = ${id} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Commission" WHERE "statementId" = ${id} FOR UPDATE`;
    const s = await tx.commissionStatement.findUnique({ where: { id } });
    if (!s) throw notFound('对账单');
    return s;
  }

  /** 和代理核对无误：定下金额，明细变成「已对账」 */
  async confirm(id: string, dto: ConfirmStatementDto, user: AuthUser): Promise<StatementDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      const s = await this.lockStatement(tx, id);
      if (s.status !== 'DRAFT') throw badRequest('只有待确认的对账单可以确认');
      await tx.commission.updateMany({
        where: { statementId: id, status: 'VOID' },
        data: { statementId: null },
      });
      const live = (await this.live(tx, [id])).get(id)!;
      const counts = await Promise.all([
        tx.commission.count({ where: { statementId: id } }),
        tx.payment.count({ where: { statementId: id } }),
      ]);
      if (counts[0] + counts[1] === 0) throw badRequest('对账单是空的，作废即可');
      await tx.commission.updateMany({
        where: { statementId: id, status: 'RELEASABLE' },
        data: { status: 'SETTLED' },
      });
      await tx.commissionStatement.update({
        where: { id },
        data: {
          status: 'CONFIRMED',
          commissionCents: live.commissionCents,
          collectedCents: live.collectedCents,
          payableCents: live.commissionCents - live.collectedCents,
          confirmedById: user.id,
          confirmedAt: new Date(),
          note: dto.note?.trim() || s.note,
        },
      });
    });
    return this.get(id);
  }

  /** 登记打款（应付为负时是代理补交了差额），明细变成「已发放」 */
  async pay(id: string, dto: PayStatementDto, user: AuthUser): Promise<StatementDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      const s = await this.lockStatement(tx, id);
      if (s.status !== 'CONFIRMED') throw badRequest('只有已确认的对账单可以登记打款');
      if (s.payableCents !== 0 && !dto.method) {
        throw badRequest(s.payableCents > 0 ? '请选择打款方式' : '请选择代理补交的收款方式');
      }
      const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
      await tx.commission.updateMany({
        where: { statementId: id, status: 'SETTLED' },
        data: { status: 'PAID' },
      });
      await tx.commissionStatement.update({
        where: { id },
        data: {
          status: 'PAID',
          paidById: user.id,
          paidAt,
          payMethod: s.payableCents === 0 ? null : dto.method,
          payReference: dto.reference?.trim() || null,
        },
      });
    });
    return this.get(id);
  }

  /** 作废：佣金退回可结算、代收款退回未抵扣，下次出单重新收录。已结清的不能作废 */
  async cancel(id: string, dto: CancelStatementDto): Promise<StatementDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      const s = await this.lockStatement(tx, id);
      if (s.status !== 'DRAFT' && s.status !== 'CONFIRMED') {
        throw badRequest('已结清或已作废的对账单不能作废');
      }
      const live = (await this.live(tx, [id])).get(id)!;
      const snapshot =
        s.status === 'DRAFT'
          ? {
              commissionCents: live.commissionCents,
              collectedCents: live.collectedCents,
              payableCents: live.commissionCents - live.collectedCents,
            }
          : {};
      await tx.commission.updateMany({
        where: { statementId: id, status: 'SETTLED' },
        data: { status: 'RELEASABLE' },
      });
      await tx.commission.updateMany({ where: { statementId: id }, data: { statementId: null } });
      await tx.payment.updateMany({ where: { statementId: id }, data: { statementId: null } });
      await tx.commissionStatement.update({
        where: { id },
        data: {
          ...snapshot,
          status: 'CANCELLED',
          cancelledAt: new Date(),
          note: dto.reason.trim(),
        },
      });
    });
    return this.get(id);
  }
}

// ─────────────── Controller ───────────────

@ApiTags('代理')
@ApiBearerAuth()
@Controller('commission-statements')
export class StatementsController {
  constructor(private readonly statements: StatementsService) {}

  @Get()
  @RequireAnyPermission(...COMMISSION_VIEW_PERMISSIONS)
  @ApiOperation({ summary: '佣金对账单列表' })
  @ApiOkResponse({ type: StatementListDto })
  list(@Query() q: StatementQueryDto): Promise<StatementListDto> {
    return this.statements.list(q);
  }

  @Post('generate')
  @HttpCode(200)
  @RequirePermissions('commission:settle')
  @Audit('statement.generate', '生成佣金对账单')
  @ApiOperation({
    summary: '生成某个月的对账单（每月 1 号会自动生成上个月的；已有草稿的补进新明细）',
  })
  @ApiOkResponse({ type: GenerateResultDto })
  generate(
    @Body() dto: GenerateStatementsDto,
    @CurrentUser() user: AuthUser,
  ): Promise<GenerateResultDto> {
    return this.statements.generate(dto, user);
  }

  @Get(':id')
  @RequireAnyPermission(...COMMISSION_VIEW_PERMISSIONS)
  @ApiOperation({ summary: '对账单详情：佣金明细和代收款' })
  @ApiOkResponse({ type: StatementDetailDto })
  get(@Param('id') id: string): Promise<StatementDetailDto> {
    return this.statements.get(id);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @RequirePermissions('commission:settle')
  @Audit('statement.confirm', '确认佣金对账单')
  @ApiOperation({ summary: '和代理核对无误后确认，金额定下来，明细变成「已对账」' })
  @ApiOkResponse({ type: StatementDetailDto })
  confirm(
    @Param('id') id: string,
    @Body() dto: ConfirmStatementDto,
    @CurrentUser() user: AuthUser,
  ): Promise<StatementDetailDto> {
    return this.statements.confirm(id, dto, user);
  }

  @Post(':id/pay')
  @HttpCode(200)
  @RequirePermissions('commission:settle')
  @Audit('statement.pay', '登记佣金打款')
  @ApiOperation({ summary: '登记打款（或代理补交差额），明细变成「已发放」' })
  @ApiOkResponse({ type: StatementDetailDto })
  pay(
    @Param('id') id: string,
    @Body() dto: PayStatementDto,
    @CurrentUser() user: AuthUser,
  ): Promise<StatementDetailDto> {
    return this.statements.pay(id, dto, user);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('commission:settle')
  @Audit('statement.cancel', '作废佣金对账单')
  @ApiOperation({ summary: '作废对账单，明细退回可结算，下次重新出单' })
  @ApiOkResponse({ type: StatementDetailDto })
  cancel(@Param('id') id: string, @Body() dto: CancelStatementDto): Promise<StatementDetailDto> {
    return this.statements.cancel(id, dto);
  }
}

/** 佣金明细、按代理汇总和月度对账单 */
@Module({
  providers: [CommissionsService, StatementsService],
  controllers: [CommissionsController, StatementsController],
  exports: [CommissionsService, StatementsService],
})
export class CommissionsModule {}
