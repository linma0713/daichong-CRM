import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Patch,
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
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Prisma } from '@prisma/client';
import {
  AGENT_STATUSES,
  ORDER_STATUSES,
  PAYMENT_METHOD_VALUES,
  displayNo,
  parseNo,
  type AgentStatus,
  type OrderStatus,
  type PaymentMethod,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { Audit, RequireAnyPermission, RequirePermissions } from '../auth/decorators';
import {
  AgentBriefDto,
  CustomerBriefDto,
  agentBriefSelect,
  customerBriefSelect,
  toAgentBrief,
} from '../common/briefs';
import { badRequest, notFound } from '../common/errors';
import { PageQueryDto, skipTake } from '../common/pagination';
import { productName } from '../catalog/catalog';

/** 能看代理和佣金的权限：任意一个即可 */
export const AGENT_VIEW_PERMISSIONS = ['agent:read', 'agent:write', 'commission:settle'] as const;

// ─────────────── DTO ───────────────

export class AgentQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '编号、名称、微信或手机号' })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({ enum: AGENT_STATUSES, enumName: 'AgentStatus' })
  @IsOptional()
  @IsIn(AGENT_STATUSES)
  status?: AgentStatus;

  @ApiPropertyOptional({ description: '只看某个代理的下级' })
  @IsOptional()
  @IsString()
  parentId?: string;
}

/** 佣金比例（万分比）；null = 不单独设置，按商品或全局默认 */
class AgentRateFields {
  @ApiPropertyOptional({ type: Number, nullable: true, description: '首单佣金比例（万分比）' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(5000)
  firstRateBp?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: '续费佣金比例（万分比）' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(5000)
  renewalRateBp?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: '作为上级时拿的管理佣金比例（万分比）',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  @Max(5000)
  parentRateBp?: number | null;
}

class AgentFields extends AgentRateFields {
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(64)
  wechat?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: '上级代理；最多两级' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  parentId?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, enum: PAYMENT_METHOD_VALUES })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(PAYMENT_METHOD_VALUES)
  payoutMethod?: PaymentMethod | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: '佣金收款账号' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(100)
  payoutAccount?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  remark?: string | null;
}

export class CreateAgentDto extends AgentFields {
  @ApiProperty({ example: '小红书-阿杰' })
  @IsString()
  @IsNotEmpty({ message: '请输入代理名称' })
  @MaxLength(32)
  name: string;
}

export class UpdateAgentDto extends AgentFields {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: '请输入代理名称' })
  @MaxLength(32)
  name?: string;

  @ApiPropertyOptional({ enum: AGENT_STATUSES, enumName: 'AgentStatus' })
  @IsOptional()
  @IsIn(AGENT_STATUSES)
  status?: AgentStatus;
}

export class AgentDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'A00003' }) code: string;
  @ApiProperty() name: string;
  @ApiProperty({ type: String, nullable: true }) wechat: string | null;
  @ApiProperty({ type: String, nullable: true }) phone: string | null;
  @ApiProperty({ type: AgentBriefDto, nullable: true }) parent: AgentBriefDto | null;
  @ApiProperty({ enum: AGENT_STATUSES, enumName: 'AgentStatus' }) status: AgentStatus;
  @ApiProperty({ type: Number, nullable: true }) firstRateBp: number | null;
  @ApiProperty({ type: Number, nullable: true }) renewalRateBp: number | null;
  @ApiProperty({ type: Number, nullable: true }) parentRateBp: number | null;
  @ApiProperty({ type: String, nullable: true }) payoutMethod: string | null;
  @ApiProperty({ type: String, nullable: true }) payoutAccount: string | null;
  @ApiProperty({ type: String, nullable: true }) remark: string | null;
  @ApiProperty({ description: '下级代理数' }) childCount: number;
  @ApiProperty({ description: '绑定的客户数' }) customerCount: number;
  @ApiProperty({ description: '已收款的订单数（不含已取消）' }) orderCount: number;
  @ApiProperty({ description: '业绩（分）= 这些订单的已收 − 已退款' }) salesCents: number;
  @ApiProperty() createdAt: Date;
}

export class AgentListDto {
  @ApiProperty({ type: [AgentDto] }) items: AgentDto[];
  @ApiProperty() total: number;
}

export class AgentOptionDto extends AgentBriefDto {
  @ApiProperty({ enum: AGENT_STATUSES, enumName: 'AgentStatus' }) status: AgentStatus;
  @ApiProperty({ type: String, nullable: true }) parentName: string | null;
}

export class AgentCustomerDto extends CustomerBriefDto {
  @ApiProperty({ type: String, nullable: true, description: '绑定时间' }) boundAt: Date | null;
}

export class AgentOrderDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty({ type: CustomerBriefDto }) customer: CustomerBriefDto;
  @ApiProperty() productName: string;
  @ApiProperty({ enum: ORDER_STATUSES, enumName: 'OrderStatus' }) status: OrderStatus;
  @ApiProperty() amountCents: number;
  @ApiProperty() paidCents: number;
  @ApiProperty() refundedCents: number;
  @ApiProperty({ description: '是否客户首单' }) firstOrder: boolean;
  @ApiProperty({
    enum: ['DIRECT', 'PARENT'],
    description: 'DIRECT 自己的客户 / PARENT 下级代理的客户',
  })
  role: 'DIRECT' | 'PARENT';
  @ApiProperty({ type: AgentBriefDto, description: '直推代理' }) agent: AgentBriefDto;
  @ApiProperty({ description: '这个代理在这笔订单里的佣金比例（万分比）' }) rateBp: number;
  @ApiProperty({ description: '佣金基数（分）' }) baseCents: number;
  @ApiProperty() createdAt: Date;
}

export class AgentDetailDto extends AgentDto {
  @ApiProperty({ type: [AgentDto] }) children: AgentDto[];
  @ApiProperty({ type: [AgentCustomerDto], description: '最近 100 个绑定客户' })
  customers: AgentCustomerDto[];
  @ApiProperty({ type: [AgentOrderDto], description: '最近 100 笔订单（含下级代理的）' })
  orders: AgentOrderDto[];
}

// ─────────────── Service ───────────────

const agentInclude = {
  parent: { select: agentBriefSelect },
  _count: { select: { children: true, customers: true } },
} satisfies Prisma.AgentInclude;
type AgentRow = Prisma.AgentGetPayload<{ include: typeof agentInclude }>;

const clean = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);

@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: AgentQueryDto): Promise<AgentListDto> {
    const no = parseNo(q.keyword, 'A');
    const kw = q.keyword?.trim();
    const where: Prisma.AgentWhereInput = {
      status: q.status,
      parentId: q.parentId,
      OR: kw
        ? [
            ...(no !== undefined ? [{ no }] : []),
            ...(['name', 'wechat', 'phone'] as const).map((f) => ({
              [f]: { contains: kw, mode: 'insensitive' as const },
            })),
          ]
        : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.agent.findMany({
        where,
        include: agentInclude,
        orderBy: [{ status: 'asc' }, { no: 'asc' }],
        ...skipTake(q),
      }),
      this.prisma.agent.count({ where }),
    ]);
    return { items: await this.withStats(rows), total };
  }

  /** 下拉选项：录客户、录订单时选代理 */
  async options(): Promise<AgentOptionDto[]> {
    const rows = await this.prisma.agent.findMany({
      include: { parent: { select: { name: true } } },
      orderBy: [{ status: 'asc' }, { no: 'asc' }],
    });
    return rows.map((a) => ({
      ...toAgentBrief(a),
      status: a.status,
      parentName: a.parent?.name ?? null,
    }));
  }

  async get(id: string): Promise<AgentDetailDto> {
    const row = await this.prisma.agent.findUnique({ where: { id }, include: agentInclude });
    if (!row) throw notFound('代理');
    const [dto] = await this.withStats([row]);
    const [children, customers, orders] = await Promise.all([
      this.prisma.agent.findMany({
        where: { parentId: id },
        include: agentInclude,
        orderBy: { no: 'asc' },
      }),
      this.prisma.customer.findMany({
        where: { agentId: id, deletedAt: null },
        select: { ...customerBriefSelect, agentBoundAt: true },
        orderBy: { agentBoundAt: 'desc' },
        take: 100,
      }),
      this.prisma.order.findMany({
        where: { OR: [{ agentId: id }, { parentAgentId: id }] },
        include: {
          customer: { select: customerBriefSelect },
          agent: { select: agentBriefSelect },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    ]);
    return {
      ...dto,
      children: await this.withStats(children),
      customers: customers.map((c) => ({
        id: c.id,
        code: displayNo('C', c.no),
        name: c.name,
        wechat: c.wechat,
        telegram: c.telegram,
        boundAt: c.agentBoundAt,
      })),
      orders: orders.map((o) => {
        const direct = o.agentId === id;
        return {
          id: o.id,
          code: displayNo('D', o.no),
          customer: {
            id: o.customer.id,
            code: displayNo('C', o.customer.no),
            name: o.customer.name,
            wechat: o.customer.wechat,
            telegram: o.customer.telegram,
          },
          productName: productName(o.planName, o.termMonths, o.fulfillmentType),
          status: o.status,
          amountCents: o.amountCents,
          paidCents: o.paidCents,
          refundedCents: o.refundedCents,
          firstOrder: o.firstOrder,
          role: direct ? 'DIRECT' : 'PARENT',
          // 订单上的代理不会为空：按 agentId 或 parentAgentId 查出来的
          agent: toAgentBrief(o.agent!),
          rateBp: direct ? o.agentRateBp : o.parentRateBp,
          baseCents: o.commissionBaseCents,
          createdAt: o.createdAt,
        };
      }),
    };
  }

  async create(dto: CreateAgentDto): Promise<AgentDetailDto> {
    if (dto.parentId) await this.assertParent(dto.parentId, null);
    const row = await this.prisma.agent.create({
      data: { ...this.normalize(dto), name: dto.name.trim() },
    });
    return this.get(row.id);
  }

  async update(id: string, dto: UpdateAgentDto): Promise<AgentDetailDto> {
    const agent = await this.prisma.agent.findUnique({
      where: { id },
      include: { _count: { select: { children: true } } },
    });
    if (!agent) throw notFound('代理');
    if (dto.parentId && dto.parentId !== agent.parentId) {
      if (agent._count.children > 0) {
        throw badRequest('这个代理已经有下级，不能再挂到别的代理下面（最多两级）');
      }
      await this.assertParent(dto.parentId, id);
    }
    await this.prisma.agent.update({
      where: { id },
      data: { ...this.normalize(dto), name: dto.name?.trim(), status: dto.status },
    });
    return this.get(id);
  }

  /** 上级必须是合作中的一级代理，不能是自己 */
  private async assertParent(parentId: string, selfId: string | null): Promise<void> {
    if (parentId === selfId) throw badRequest('上级不能是自己');
    const parent = await this.prisma.agent.findUnique({ where: { id: parentId } });
    if (!parent) throw badRequest('上级代理不存在');
    if (parent.parentId) {
      throw badRequest(`${parent.name} 已经是二级代理，不能再带下级（最多两级）`);
    }
    if (parent.status !== 'ACTIVE') throw badRequest(`${parent.name} 已停用，不能作为上级`);
  }

  private normalize(dto: AgentFields) {
    return {
      wechat: clean(dto.wechat),
      phone: clean(dto.phone),
      parentId: dto.parentId,
      firstRateBp: dto.firstRateBp,
      renewalRateBp: dto.renewalRateBp,
      parentRateBp: dto.parentRateBp,
      payoutMethod: dto.payoutMethod,
      payoutAccount: clean(dto.payoutAccount),
      remark: clean(dto.remark),
    };
  }

  private async withStats(rows: AgentRow[]): Promise<AgentDto[]> {
    const ids = rows.map((r) => r.id);
    const stats = ids.length
      ? await this.prisma.order.groupBy({
          by: ['agentId'],
          where: { agentId: { in: ids }, paidCents: { gt: 0 }, status: { not: 'CANCELLED' } },
          _count: { _all: true },
          _sum: { paidCents: true, refundedCents: true },
        })
      : [];
    const byId = new Map(stats.map((s) => [s.agentId, s]));
    return rows.map((a) => {
      const s = byId.get(a.id);
      return {
        id: a.id,
        code: displayNo('A', a.no),
        name: a.name,
        wechat: a.wechat,
        phone: a.phone,
        parent: a.parent ? toAgentBrief(a.parent) : null,
        status: a.status,
        firstRateBp: a.firstRateBp,
        renewalRateBp: a.renewalRateBp,
        parentRateBp: a.parentRateBp,
        payoutMethod: a.payoutMethod,
        payoutAccount: a.payoutAccount,
        remark: a.remark,
        childCount: a._count.children,
        customerCount: a._count.customers,
        orderCount: s?._count._all ?? 0,
        salesCents: (s?._sum.paidCents ?? 0) - (s?._sum.refundedCents ?? 0),
        createdAt: a.createdAt,
      };
    });
  }
}

// ─────────────── Controller ───────────────

@ApiTags('代理')
@ApiBearerAuth()
@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  @RequireAnyPermission(...AGENT_VIEW_PERMISSIONS)
  @ApiOperation({ summary: '代理列表（含客户数、订单数、业绩）' })
  @ApiOkResponse({ type: AgentListDto })
  list(@Query() q: AgentQueryDto): Promise<AgentListDto> {
    return this.agents.list(q);
  }

  @Get('options')
  @RequireAnyPermission('customer:write', 'order:write', ...AGENT_VIEW_PERMISSIONS)
  @ApiOperation({ summary: '代理下拉选项（录客户、录订单时选择）' })
  @ApiOkResponse({ type: [AgentOptionDto] })
  options(): Promise<AgentOptionDto[]> {
    return this.agents.options();
  }

  @Get(':id')
  @RequireAnyPermission(...AGENT_VIEW_PERMISSIONS)
  @ApiOperation({ summary: '代理详情（下级、客户、订单）' })
  @ApiOkResponse({ type: AgentDetailDto })
  get(@Param('id') id: string): Promise<AgentDetailDto> {
    return this.agents.get(id);
  }

  @Post()
  @RequirePermissions('agent:write')
  @Audit('agent.create', '新增代理')
  @ApiOperation({ summary: '新增代理' })
  @ApiOkResponse({ type: AgentDetailDto })
  create(@Body() dto: CreateAgentDto): Promise<AgentDetailDto> {
    return this.agents.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('agent:write')
  @Audit('agent.update', '修改代理（资料、上级、佣金比例或停用）')
  @ApiOperation({ summary: '修改代理；改比例只影响之后的新订单' })
  @ApiOkResponse({ type: AgentDetailDto })
  update(@Param('id') id: string, @Body() dto: UpdateAgentDto): Promise<AgentDetailDto> {
    return this.agents.update(id, dto);
  }
}

@Module({
  providers: [AgentsService],
  controllers: [AgentsController],
  exports: [AgentsService],
})
export class AgentsModule {}
