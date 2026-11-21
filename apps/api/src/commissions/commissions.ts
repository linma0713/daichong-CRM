import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { Prisma } from '@prisma/client';
import {
  COMMISSION_STATUSES,
  displayNo,
  parseNo,
  type CommissionKind,
  type CommissionRole,
  type CommissionStatus,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RequireAnyPermission } from '../auth/decorators';
import {
  AgentBriefDto,
  CustomerBriefDto,
  agentBriefSelect,
  customerBriefSelect,
  toAgentBrief,
} from '../common/briefs';
import { PageQueryDto, skipTake } from '../common/pagination';
import { productName } from '../catalog/catalog';

/** 能看佣金的权限：代理相关或财务查看，任意一个即可 */
export const COMMISSION_VIEW_PERMISSIONS = [
  'agent:read',
  'agent:write',
  'commission:settle',
  'finance:read',
] as const;

const ROLES: CommissionRole[] = ['DIRECT', 'PARENT'];
const KINDS: CommissionKind[] = ['ACCRUAL', 'CLAWBACK'];

// ─────────────── DTO ───────────────

export class CommissionRefDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
}

export class CommissionDto {
  @ApiProperty() id: string;
  @ApiProperty({ type: CommissionRefDto, description: '订单' }) order: CommissionRefDto;
  @ApiProperty({ type: CustomerBriefDto }) customer: CustomerBriefDto;
  @ApiProperty() productName: string;
  @ApiProperty({ type: AgentBriefDto }) agent: AgentBriefDto;
  @ApiProperty({ enum: ROLES, enumName: 'CommissionRole' }) role: CommissionRole;
  @ApiProperty({ enum: KINDS, enumName: 'CommissionKind' }) kind: CommissionKind;
  @ApiProperty({ description: '第几期；扣回为 0' }) seq: number;
  @ApiProperty({ description: '一共几期（加购质保的按服务月数拆分）' }) periods: number;
  @ApiProperty({ description: '佣金比例（万分比）' }) rateBp: number;
  @ApiProperty({ description: '这一期的佣金基数（分）' }) baseCents: number;
  @ApiProperty({ description: '计提时的金额（分），扣回为负数' }) originalCents: number;
  @ApiProperty({ description: '当前金额（分）= 计提金额 − 退款扣减' }) amountCents: number;
  @ApiProperty({ enum: COMMISSION_STATUSES, enumName: 'CommissionStatus' })
  status: CommissionStatus;
  @ApiProperty({ description: '解冻时间' }) releaseAt: Date;
  @ApiProperty({ type: String, nullable: true }) releasedAt: Date | null;
  @ApiProperty({ type: CommissionRefDto, nullable: true, description: '因为哪笔退款扣减 / 扣回' })
  refund: CommissionRefDto | null;
  @ApiProperty() createdAt: Date;
}

export class CommissionQueryDto extends PageQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  agentId?: string;

  @ApiPropertyOptional({ enum: COMMISSION_STATUSES, enumName: 'CommissionStatus' })
  @IsOptional()
  @IsIn(COMMISSION_STATUSES)
  status?: CommissionStatus;

  @ApiPropertyOptional({ enum: ROLES, enumName: 'CommissionRole' })
  @IsOptional()
  @IsIn(ROLES)
  role?: CommissionRole;

  @ApiPropertyOptional({ enum: KINDS, enumName: 'CommissionKind' })
  @IsOptional()
  @IsIn(KINDS)
  kind?: CommissionKind;

  @ApiPropertyOptional({ description: '订单编号或客户称呼' })
  @IsOptional()
  @IsString()
  keyword?: string;
}

export class CommissionListDto {
  @ApiProperty({ type: [CommissionDto] }) items: CommissionDto[];
  @ApiProperty() total: number;
  @ApiProperty({ description: '符合条件的佣金金额合计（分，不含已作废）' }) sumCents: number;
}

export class AgentCommissionSummaryDto {
  @ApiProperty({ type: AgentBriefDto }) agent: AgentBriefDto;
  @ApiProperty({ description: '冻结中（分）' }) frozenCents: number;
  @ApiProperty({ description: '可结算（分），已扣掉待扣回' }) releasableCents: number;
  @ApiProperty({ description: '其中待扣回（分，负数）' }) clawbackCents: number;
  @ApiProperty({ description: '已对账待打款（分）' }) settledCents: number;
  @ApiProperty({ description: '已发放（分）' }) paidCents: number;
}

// ─────────────── 转换 ───────────────

export const commissionInclude = {
  order: {
    select: {
      id: true,
      no: true,
      planName: true,
      termMonths: true,
      fulfillmentType: true,
      withWarranty: true,
      customer: { select: customerBriefSelect },
    },
  },
  agent: { select: agentBriefSelect },
  refund: { select: { id: true, no: true } },
} satisfies Prisma.CommissionInclude;
type CommissionRow = Prisma.CommissionGetPayload<{ include: typeof commissionInclude }>;

export function toCommissionDto(c: CommissionRow): CommissionDto {
  const o = c.order;
  return {
    id: c.id,
    order: { id: o.id, code: displayNo('D', o.no) },
    customer: {
      id: o.customer.id,
      code: displayNo('C', o.customer.no),
      name: o.customer.name,
      wechat: o.customer.wechat,
      telegram: o.customer.telegram,
    },
    productName: productName(o.planName, o.termMonths, o.fulfillmentType),
    agent: toAgentBrief(c.agent),
    role: c.role,
    kind: c.kind,
    seq: c.seq,
    periods: o.withWarranty ? Math.max(1, o.termMonths) : 1,
    rateBp: c.rateBp,
    baseCents: c.baseCents,
    originalCents: c.originalCents,
    amountCents: c.amountCents,
    status: c.status,
    releaseAt: c.releaseAt,
    releasedAt: c.releasedAt,
    refund: c.refund ? { id: c.refund.id, code: displayNo('K', c.refund.no) } : null,
    createdAt: c.createdAt,
  };
}

/** 一组佣金按状态汇总 */
export function summarize(
  rows: { status: CommissionStatus; kind: CommissionKind; amountCents: number }[],
) {
  const s = { frozenCents: 0, releasableCents: 0, clawbackCents: 0, settledCents: 0, paidCents: 0 };
  for (const r of rows) {
    if (r.status === 'FROZEN') s.frozenCents += r.amountCents;
    if (r.status === 'RELEASABLE') s.releasableCents += r.amountCents;
    if (r.status === 'RELEASABLE' && r.kind === 'CLAWBACK') s.clawbackCents += r.amountCents;
    if (r.status === 'SETTLED') s.settledCents += r.amountCents;
    if (r.status === 'PAID') s.paidCents += r.amountCents;
  }
  return s;
}

// ─────────────── Service ───────────────

@Injectable()
export class CommissionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: CommissionQueryDto): Promise<CommissionListDto> {
    const no = parseNo(q.keyword, 'D');
    const kw = q.keyword?.trim();
    const where: Prisma.CommissionWhereInput = {
      agentId: q.agentId,
      status: q.status,
      role: q.role,
      kind: q.kind,
      order: kw
        ? {
            OR: [
              ...(no !== undefined ? [{ no }] : []),
              { customer: { name: { contains: kw, mode: 'insensitive' } } },
            ],
          }
        : undefined,
    };
    const [rows, total, sum] = await this.prisma.$transaction([
      this.prisma.commission.findMany({
        where,
        include: commissionInclude,
        orderBy: [{ createdAt: 'desc' }, { seq: 'asc' }],
        ...skipTake(q),
      }),
      this.prisma.commission.count({ where }),
      this.prisma.commission.aggregate({
        where: { AND: [where, q.status ? {} : { status: { not: 'VOID' } }] },
        _sum: { amountCents: true },
      }),
    ]);
    return { items: rows.map(toCommissionDto), total, sumCents: sum._sum.amountCents ?? 0 };
  }

  /** 按代理汇总：冻结中、可结算（含待扣回）、已对账、已发放 */
  async summary(): Promise<AgentCommissionSummaryDto[]> {
    const groups = await this.prisma.commission.groupBy({
      by: ['agentId', 'status', 'kind'],
      where: { status: { not: 'VOID' } },
      _sum: { amountCents: true },
    });
    const agentIds = [...new Set(groups.map((g) => g.agentId))];
    const agents = await this.prisma.agent.findMany({
      where: { id: { in: agentIds } },
      select: agentBriefSelect,
      orderBy: { no: 'asc' },
    });
    return agents
      .map((a) => ({
        agent: toAgentBrief(a),
        ...summarize(
          groups
            .filter((g) => g.agentId === a.id)
            .map((g) => ({ status: g.status, kind: g.kind, amountCents: g._sum.amountCents ?? 0 })),
        ),
      }))
      .sort((x, y) => y.releasableCents + y.frozenCents - (x.releasableCents + x.frozenCents));
  }
}

// ─────────────── Controller ───────────────

@ApiTags('代理')
@ApiBearerAuth()
@Controller('commissions')
export class CommissionsController {
  constructor(private readonly commissions: CommissionsService) {}

  @Get()
  @RequireAnyPermission(...COMMISSION_VIEW_PERMISSIONS)
  @ApiOperation({ summary: '佣金明细' })
  @ApiOkResponse({ type: CommissionListDto })
  list(@Query() q: CommissionQueryDto): Promise<CommissionListDto> {
    return this.commissions.list(q);
  }

  @Get('summary')
  @RequireAnyPermission(...COMMISSION_VIEW_PERMISSIONS)
  @ApiOperation({ summary: '按代理汇总佣金（冻结中、可结算、已对账、已发放）' })
  @ApiOkResponse({ type: [AgentCommissionSummaryDto] })
  summary(): Promise<AgentCommissionSummaryDto[]> {
    return this.commissions.summary();
  }
}

@Module({
  providers: [CommissionsService],
  controllers: [CommissionsController],
  exports: [CommissionsService],
})
export class CommissionsModule {}
