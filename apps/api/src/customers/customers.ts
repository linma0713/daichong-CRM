import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
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
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Prisma } from '@prisma/client';
import {
  CUSTOMER_SOURCE_VALUES,
  CUSTOMER_STAGES,
  ErrorCode,
  FOLLOW_UP_KIND_VALUES,
  LOST_REASON_VALUES,
  MANUAL_FOLLOW_UP_KINDS,
  displayNo,
  hasPermission,
  lostReasonLabel,
  parseNo,
  type CustomerSource,
  type CustomerStage,
  type FollowUpKind,
  type LostReason,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { Audit, CurrentUser, RequirePermissions } from '../auth/decorators';
import type { AuthUser } from '../common/auth-user';
import {
  AgentBriefDto,
  UserBriefDto,
  agentBriefSelect,
  toAgentBrief,
  userBriefSelect,
} from '../common/briefs';
import { scopeWhere } from '../common/data-scope';
import { badRequest, notFound } from '../common/errors';
import { OkDto } from '../auth/auth.dto';
import { PageQueryDto, skipTake } from '../common/pagination';
import { SettingsModule, SettingsService } from '../settings/settings';

const toBool = ({ value }: { value: unknown }) => value === true || value === 'true';
const CUSTOMER_SORTS = ['createdAt', 'netPaid', 'serviceEnd', 'lastContact'] as const;
type CustomerSort = (typeof CUSTOMER_SORTS)[number];

// ─────────────── DTO ───────────────

export class CustomerQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '编号、称呼、微信、Telegram、邮箱或手机号' })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({ enum: CUSTOMER_SOURCE_VALUES })
  @IsOptional()
  @IsIn(CUSTOMER_SOURCE_VALUES)
  source?: CustomerSource;

  @ApiPropertyOptional({ description: '负责人' })
  @IsOptional()
  @IsString()
  ownerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  tag?: string;

  @ApiPropertyOptional({ description: '绑定的代理' })
  @IsOptional()
  @IsString()
  agentId?: string;

  @ApiPropertyOptional({ enum: CUSTOMER_STAGES, enumName: 'CustomerStage' })
  @IsOptional()
  @IsIn(CUSTOMER_STAGES)
  stage?: CustomerStage;

  @ApiPropertyOptional({ description: '只看 VIP（累计实付达到业务设置里的门槛）' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  vip?: boolean;

  @ApiPropertyOptional({ description: '只看服务结束后还没联系过的（召回用）' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  uncontacted?: boolean;

  @ApiPropertyOptional({ enum: LOST_REASON_VALUES, description: '流失原因' })
  @IsOptional()
  @IsIn(LOST_REASON_VALUES)
  lostReason?: LostReason;

  @ApiPropertyOptional({
    enum: CUSTOMER_SORTS,
    description:
      'createdAt 最新录入 / netPaid 累计实付从高到低 / serviceEnd 服务最近结束 / lastContact 最久没联系',
  })
  @IsOptional()
  @IsIn(CUSTOMER_SORTS)
  sort?: CustomerSort;
}

class CustomerFields {
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  wechat?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  telegram?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsEmail({}, { message: '邮箱格式不正确' })
  email?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @ApiPropertyOptional({ enum: CUSTOMER_SOURCE_VALUES })
  @IsOptional()
  @IsIn(CUSTOMER_SOURCE_VALUES)
  source?: CustomerSource;

  @ApiPropertyOptional({ type: String, nullable: true, description: '推荐人（老客户 ID）' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  referrerId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: '绑定的代理：客户之后的订单都算这个代理的。改绑 / 解绑需要「编辑代理」权限',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  agentId?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(16, { each: true })
  tags?: string[];

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string | null;
}

export class CreateCustomerDto extends CustomerFields {
  @ApiProperty({ example: '王先生' })
  @IsString()
  @IsNotEmpty({ message: '请输入客户称呼' })
  @MaxLength(32)
  name: string;

  @ApiPropertyOptional({ description: '负责人，不填为自己；指定他人需要「全部数据」或同组范围' })
  @IsOptional()
  @IsString()
  ownerId?: string;
}

export class UpdateCustomerDto extends CustomerFields {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  name?: string;
}

export class TransferCustomerDto {
  @ApiProperty({ description: '新的负责人' })
  @IsString()
  ownerId: string;
}

export class CreateFollowUpDto {
  @ApiProperty({ example: '已微信提醒续费，客户说周末付款' })
  @IsString()
  @IsNotEmpty({ message: '请输入跟进内容' })
  @MaxLength(1000)
  content: string;

  @ApiPropertyOptional({ enum: MANUAL_FOLLOW_UP_KINDS, description: '跟进 / 续费提醒 / 召回' })
  @IsOptional()
  @IsIn(MANUAL_FOLLOW_UP_KINDS)
  kind?: FollowUpKind;

  @ApiPropertyOptional({ description: '关联的订阅（续费提醒时填写）' })
  @IsOptional()
  @IsString()
  subscriptionId?: string;
}

export class LostReasonDto {
  @ApiProperty({ enum: LOST_REASON_VALUES })
  @IsIn(LOST_REASON_VALUES, { message: '请选择流失原因' })
  reason: LostReason;

  @ApiPropertyOptional({ example: '说官方涨价后觉得不划算' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CustomerRefDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
}

export class CustomerDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'C00012' }) code: string;
  @ApiProperty() name: string;
  @ApiProperty({ type: String, nullable: true }) wechat: string | null;
  @ApiProperty({ type: String, nullable: true }) telegram: string | null;
  @ApiProperty({ type: String, nullable: true }) email: string | null;
  @ApiProperty({ type: String, nullable: true }) phone: string | null;
  @ApiProperty({ enum: CUSTOMER_SOURCE_VALUES }) source: string;
  @ApiProperty({ type: [String] }) tags: string[];
  @ApiProperty({ type: String, nullable: true }) remark: string | null;
  @ApiProperty({ type: UserBriefDto }) owner: UserBriefDto;
  @ApiProperty({ type: CustomerRefDto, nullable: true }) referrer: CustomerRefDto | null;
  @ApiProperty({ type: AgentBriefDto, nullable: true, description: '绑定的代理' })
  agent: AgentBriefDto | null;
  @ApiProperty({ type: String, nullable: true, description: '绑定代理的时间' })
  agentBoundAt: Date | null;
  @ApiProperty({ description: '服务中的订阅数' }) activeSubscriptionCount: number;
  @ApiProperty({ type: String, nullable: true, description: '最近一个到期时间' })
  nextExpiryAt: Date | null;
  @ApiProperty({ enum: CUSTOMER_STAGES, enumName: 'CustomerStage' }) stage: CustomerStage;
  @ApiProperty({ type: String, nullable: true }) stageChangedAt: Date | null;
  @ApiProperty({ description: '累计实付达到 VIP 门槛' }) vip: boolean;
  @ApiProperty({ description: '累计实付（分）= 已收 − 已退' }) netPaidCents: number;
  @ApiProperty({ description: '收齐款的订单数' }) paidOrderCount: number;
  @ApiProperty({ type: String, nullable: true }) firstPaidAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) lastPaidAt: Date | null;
  @ApiProperty({ type: String, nullable: true, description: '最晚的服务结束时间' })
  serviceEndAt: Date | null;
  @ApiProperty({ type: String, nullable: true, description: '最近一次跟进时间' })
  lastContactAt: Date | null;
  @ApiProperty({ enum: LOST_REASON_VALUES, nullable: true }) lostReason: string | null;
  @ApiProperty({ type: String, nullable: true }) lostNote: string | null;
  @ApiProperty({ type: String, nullable: true }) lostReasonAt: Date | null;
  @ApiProperty() createdAt: Date;
}

export class CustomerListDto {
  @ApiProperty({ type: [CustomerDto] }) items: CustomerDto[];
  @ApiProperty() total: number;
}

export class FollowUpDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: FOLLOW_UP_KIND_VALUES }) kind: string;
  @ApiProperty() content: string;
  @ApiProperty({ type: UserBriefDto }) user: UserBriefDto;
  @ApiProperty({ type: String, nullable: true }) subscriptionId: string | null;
  @ApiProperty() createdAt: Date;
}

export class StageCountDto {
  @ApiProperty({ enum: CUSTOMER_STAGES, enumName: 'CustomerStage' }) stage: CustomerStage;
  @ApiProperty() count: number;
}

export class LostReasonCountDto {
  @ApiProperty({ type: String, nullable: true, description: 'null = 没记录原因' })
  reason: string | null;
  @ApiProperty() count: number;
}

/** 客户分层统计（按数据范围） */
export class CustomerSegmentsDto {
  @ApiProperty() total: number;
  @ApiProperty({ type: [StageCountDto] }) stages: StageCountDto[];
  @ApiProperty() vip: number;
  @ApiProperty({ description: 'VIP 门槛（分）' }) vipThresholdCents: number;
  @ApiProperty({ description: '召回期（天）' }) recallWindowDays: number;
  @ApiProperty({ description: '沉睡客户里服务结束后还没联系过的' }) dormantUncontacted: number;
  @ApiProperty({ type: [LostReasonCountDto], description: '沉睡 + 流失客户的流失原因分布' })
  lostReasons: LostReasonCountDto[];
}

export class CustomerDetailDto extends CustomerDto {
  @ApiProperty({ type: [FollowUpDto], description: '最近 50 条跟进记录' })
  followUps: FollowUpDto[];
}

// ─────────────── Service ───────────────

const customerInclude = {
  owner: { select: userBriefSelect },
  referrer: { select: { id: true, no: true, name: true } },
  agent: { select: agentBriefSelect },
} satisfies Prisma.CustomerInclude;
type CustomerRow = Prisma.CustomerGetPayload<{ include: typeof customerInclude }>;

const CONTACT_FIELDS = [
  ['wechat', '微信'],
  ['telegram', 'Telegram'],
  ['email', '邮箱'],
  ['phone', '手机号'],
] as const;

/** 当前员工能看到的客户 */
export function visibleCustomers(user: AuthUser): Prisma.CustomerWhereInput {
  return { deletedAt: null, ...scopeWhere(user) };
}

/** 能否把客户交给 targetOwner 负责：全部范围可以给任何人，小组范围只能给同组同事 */
function assertCanAssign(user: AuthUser, target: { id: string; teamId: string | null }): void {
  if (target.id === user.id || user.dataScope === 'ALL') return;
  if (user.dataScope === 'TEAM' && user.teamId && target.teamId === user.teamId) return;
  throw new ForbiddenException({
    code: ErrorCode.FORBIDDEN,
    message: '你只能把客户分配给自己（或同组同事）',
  });
}

const clean = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null);

/** 服务结束后还没联系过：从没跟进过，或最近一次跟进早于服务结束 */
export function uncontactedSinceServiceEnd(prisma: PrismaService): Prisma.CustomerWhereInput {
  return {
    OR: [{ lastContactAt: null }, { lastContactAt: { lt: prisma.customer.fields.serviceEndAt } }],
  };
}

/** VIP：累计实付达到门槛；门槛设成 0 也至少要付过款 */
export const isVip = (netPaidCents: number, thresholdCents: number) =>
  netPaidCents > 0 && netPaidCents >= thresholdCents;

const SORT_ORDER: Record<CustomerSort, Prisma.CustomerOrderByWithRelationInput[]> = {
  createdAt: [{ createdAt: 'desc' }],
  netPaid: [{ netPaidCents: 'desc' }, { createdAt: 'desc' }],
  serviceEnd: [{ serviceEndAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
  lastContact: [{ lastContactAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'desc' }],
};

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async list(q: CustomerQueryDto, user: AuthUser): Promise<CustomerListDto> {
    const no = parseNo(q.keyword, 'C');
    const kw = q.keyword?.trim();
    const { vipThresholdCents } = await this.settings.getAll();
    // 数据范围单独放进 AND，避免筛选条件（例如 ownerId）把范围覆盖掉
    const and: Prisma.CustomerWhereInput[] = [visibleCustomers(user)];
    if (q.uncontacted) and.push(this.uncontactedWhere());
    const where: Prisma.CustomerWhereInput = {
      AND: and,
      source: q.source,
      ownerId: q.ownerId,
      agentId: q.agentId,
      stage: q.stage,
      lostReason: q.lostReason,
      netPaidCents: q.vip ? { gte: Math.max(1, vipThresholdCents) } : undefined,
      tags: q.tag ? { has: q.tag } : undefined,
      OR: kw
        ? [
            ...(no !== undefined ? [{ no }] : []),
            ...(['name', 'wechat', 'telegram', 'email', 'phone'] as const).map((f) => ({
              [f]: { contains: kw, mode: 'insensitive' as const },
            })),
          ]
        : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        include: customerInclude,
        orderBy: SORT_ORDER[q.sort ?? 'createdAt'],
        ...skipTake(q),
      }),
      this.prisma.customer.count({ where }),
    ]);
    return { items: await this.withSubscriptionStats(rows, vipThresholdCents), total };
  }

  /** 客户分层统计：各阶段人数、VIP、待召回、流失原因分布 */
  async segments(user: AuthUser): Promise<CustomerSegmentsDto> {
    const { vipThresholdCents, recallWindowDays } = await this.settings.getAll();
    const scope = visibleCustomers(user);
    const [byStage, vip, dormantUncontacted, byReason] = await Promise.all([
      this.prisma.customer.groupBy({ by: ['stage'], where: scope, _count: { _all: true } }),
      this.prisma.customer.count({
        where: { ...scope, netPaidCents: { gte: Math.max(1, vipThresholdCents) } },
      }),
      this.prisma.customer.count({
        where: { AND: [scope, { stage: 'DORMANT' }, this.uncontactedWhere()] },
      }),
      this.prisma.customer.groupBy({
        by: ['lostReason'],
        where: { ...scope, stage: { in: ['DORMANT', 'CHURNED'] } },
        _count: { _all: true },
      }),
    ]);
    const count = new Map(byStage.map((r) => [r.stage, r._count._all]));
    return {
      total: byStage.reduce((sum, r) => sum + r._count._all, 0),
      stages: CUSTOMER_STAGES.map((stage) => ({ stage, count: count.get(stage) ?? 0 })),
      vip,
      vipThresholdCents,
      recallWindowDays,
      dormantUncontacted,
      lostReasons: byReason
        .map((r) => ({ reason: r.lostReason, count: r._count._all }))
        .sort((a, b) => b.count - a.count),
    };
  }

  /** 记录流失原因（同时写一条跟进记录）。之后客户再付款会自动清掉 */
  async setLostReason(id: string, dto: LostReasonDto, user: AuthUser): Promise<CustomerDetailDto> {
    await this.findVisible(id, user);
    const now = new Date();
    const note = dto.note?.trim() || null;
    await this.prisma.$transaction([
      this.prisma.customer.update({
        where: { id },
        data: { lostReason: dto.reason, lostNote: note, lostReasonAt: now, lastContactAt: now },
      }),
      this.prisma.followUp.create({
        data: {
          customerId: id,
          kind: 'lost_reason',
          content: `流失原因：${lostReasonLabel(dto.reason)}${note ? `。${note}` : ''}`,
          userId: user.id,
          createdAt: now,
        },
      }),
    ]);
    return this.get(id, user);
  }

  private uncontactedWhere(): Prisma.CustomerWhereInput {
    return uncontactedSinceServiceEnd(this.prisma);
  }

  async get(id: string, user: AuthUser): Promise<CustomerDetailDto> {
    const row = await this.findVisible(id, user);
    const [dto] = await this.withSubscriptionStats([row]);
    const followUps = await this.prisma.followUp.findMany({
      where: { customerId: id },
      include: { user: { select: userBriefSelect } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return {
      ...dto,
      followUps: followUps.map((f) => ({
        id: f.id,
        kind: f.kind,
        content: f.content,
        user: f.user,
        subscriptionId: f.subscriptionId,
        createdAt: f.createdAt,
      })),
    };
  }

  async create(dto: CreateCustomerDto, user: AuthUser): Promise<CustomerDto> {
    const ownerId = dto.ownerId ?? user.id;
    const owner = await this.findActiveUser(ownerId);
    assertCanAssign(user, owner);
    const { agentId, ...data } = this.normalize(dto);
    await this.assertNoDuplicate(data);
    await this.assertReferrer(data.referrerId, undefined, user);
    if (agentId) await this.assertAgent(agentId);
    const row = await this.prisma.customer.create({
      data: {
        name: dto.name.trim(),
        ...data,
        source: data.source ?? (agentId ? 'agent' : 'organic'),
        tags: data.tags ?? [],
        ownerId,
        teamId: owner.teamId,
        agentId: agentId ?? null,
        agentBoundAt: agentId ? new Date() : null,
      },
      include: customerInclude,
    });
    return (await this.withSubscriptionStats([row]))[0];
  }

  async update(id: string, dto: UpdateCustomerDto, user: AuthUser): Promise<CustomerDto> {
    const current = await this.findVisible(id, user);
    const { agentId, ...data } = this.normalize(dto);
    await this.assertNoDuplicate(data, id);
    await this.assertReferrer(data.referrerId, id, user);
    const agentChanged = agentId !== undefined && agentId !== current.agentId;
    if (agentChanged) {
      // 第一次绑定客服就能做；已经绑了代理再改绑 / 解绑，会影响代理的业绩归属，要「编辑代理」权限
      if (current.agentId && !hasPermission(user.permissions, 'agent:write')) {
        throw new ForbiddenException({
          code: ErrorCode.FORBIDDEN,
          message: '客户已绑定代理，改绑或解绑需要「编辑代理」权限',
        });
      }
      if (agentId) await this.assertAgent(agentId);
    }
    const row = await this.prisma.customer.update({
      where: { id },
      data: {
        ...data,
        name: dto.name?.trim(),
        ...(agentChanged ? { agentId, agentBoundAt: agentId ? new Date() : null } : {}),
      },
      include: customerInclude,
    });
    return (await this.withSubscriptionStats([row]))[0];
  }

  /** 换负责人：客户名下的订阅一起转（续费提醒跟着走），历史订单保持原负责人 */
  async transfer(id: string, ownerId: string, user: AuthUser): Promise<CustomerDetailDto> {
    await this.findVisible(id, user);
    const owner = await this.findActiveUser(ownerId);
    assertCanAssign(user, owner);
    await this.prisma.$transaction([
      this.prisma.customer.update({ where: { id }, data: { ownerId, teamId: owner.teamId } }),
      this.prisma.subscription.updateMany({
        where: { customerId: id },
        data: { ownerId, teamId: owner.teamId },
      }),
    ]);
    return this.get(id, user);
  }

  /** 删除客户：只能删没有订单的（录错了的情况），有订单的保留历史 */
  async remove(id: string, user: AuthUser): Promise<void> {
    await this.findVisible(id, user);
    const orders = await this.prisma.order.count({ where: { customerId: id } });
    if (orders > 0) throw badRequest('客户已有订单，不能删除');
    await this.prisma.customer.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  async addFollowUp(id: string, dto: CreateFollowUpDto, user: AuthUser): Promise<FollowUpDto> {
    await this.findVisible(id, user);
    if (dto.subscriptionId) {
      const sub = await this.prisma.subscription.findFirst({
        where: { id: dto.subscriptionId, customerId: id },
      });
      if (!sub) throw badRequest('订阅不属于这个客户');
    }
    const now = new Date();
    const [f] = await this.prisma.$transaction([
      this.prisma.followUp.create({
        data: {
          customerId: id,
          subscriptionId: dto.subscriptionId ?? null,
          kind: dto.kind ?? (dto.subscriptionId ? 'renewal_reminder' : 'note'),
          content: dto.content.trim(),
          userId: user.id,
          createdAt: now,
        },
        include: { user: { select: userBriefSelect } },
      }),
      this.prisma.customer.update({ where: { id }, data: { lastContactAt: now } }),
    ]);
    return {
      id: f.id,
      kind: f.kind,
      content: f.content,
      user: f.user,
      subscriptionId: f.subscriptionId,
      createdAt: f.createdAt,
    };
  }

  async findVisible(id: string, user: AuthUser): Promise<CustomerRow> {
    const row = await this.prisma.customer.findFirst({
      where: { id, ...visibleCustomers(user) },
      include: customerInclude,
    });
    if (!row) throw notFound('客户');
    return row;
  }

  private normalize(dto: CustomerFields) {
    const email = clean(dto.email);
    return {
      wechat: clean(dto.wechat),
      telegram: clean(dto.telegram),
      email: email ? email.toLowerCase() : email,
      phone: clean(dto.phone),
      source: dto.source,
      referrerId: dto.referrerId,
      agentId: dto.agentId === undefined ? undefined : dto.agentId || null,
      tags: dto.tags ? [...new Set(dto.tags.map((t) => t.trim()).filter(Boolean))] : undefined,
      remark: clean(dto.remark),
    };
  }

  /** 同一个微信 / Telegram / 邮箱 / 手机号只能属于一个客户，避免两个客服重复跟进 */
  private async assertNoDuplicate(
    data: Partial<Record<(typeof CONTACT_FIELDS)[number][0], string | null | undefined>>,
    exceptId?: string,
  ): Promise<void> {
    for (const [field, label] of CONTACT_FIELDS) {
      const value = data[field];
      if (!value) continue;
      const dup = await this.prisma.customer.findFirst({
        where: {
          deletedAt: null,
          id: exceptId ? { not: exceptId } : undefined,
          [field]: { equals: value, mode: 'insensitive' },
        },
        include: { owner: { select: userBriefSelect } },
      });
      if (dup) {
        throw badRequest(
          `这个${label}已经是客户 ${displayNo('C', dup.no)} 的了（负责人：${dup.owner.displayName}）`,
          'CUSTOMER_DUPLICATE',
        );
      }
    }
  }

  private async assertReferrer(
    referrerId: string | null | undefined,
    selfId: string | undefined,
    user: AuthUser,
  ): Promise<void> {
    if (!referrerId) return;
    if (referrerId === selfId) throw badRequest('推荐人不能是客户自己');
    const ref = await this.prisma.customer.findFirst({
      where: { id: referrerId, ...visibleCustomers(user) },
    });
    if (!ref) throw badRequest('推荐人不存在');
  }

  /** 新绑定的代理必须存在且在合作中 */
  private async assertAgent(agentId: string): Promise<void> {
    const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) throw badRequest('代理不存在');
    if (agent.status !== 'ACTIVE') throw badRequest('代理已停用，不能绑定新客户');
  }

  private async findActiveUser(id: string) {
    const u = await this.prisma.user.findFirst({
      where: { id, deletedAt: null, status: 'ACTIVE' },
      select: { id: true, teamId: true },
    });
    if (!u) throw badRequest('负责人不存在或已停用');
    return u;
  }

  private async withSubscriptionStats(
    rows: CustomerRow[],
    vipThreshold?: number,
  ): Promise<CustomerDto[]> {
    const vipThresholdCents = vipThreshold ?? (await this.settings.getAll()).vipThresholdCents;
    const stats = rows.length
      ? await this.prisma.subscription.groupBy({
          by: ['customerId'],
          where: { customerId: { in: rows.map((r) => r.id) }, status: 'ACTIVE' },
          _count: { _all: true },
          _min: { endAt: true },
        })
      : [];
    const byId = new Map(stats.map((s) => [s.customerId, s]));
    return rows.map((r) => ({
      id: r.id,
      code: displayNo('C', r.no),
      name: r.name,
      wechat: r.wechat,
      telegram: r.telegram,
      email: r.email,
      phone: r.phone,
      source: r.source,
      tags: r.tags,
      remark: r.remark,
      owner: r.owner,
      referrer: r.referrer
        ? { id: r.referrer.id, code: displayNo('C', r.referrer.no), name: r.referrer.name }
        : null,
      agent: r.agent ? toAgentBrief(r.agent) : null,
      agentBoundAt: r.agentBoundAt,
      activeSubscriptionCount: byId.get(r.id)?._count._all ?? 0,
      nextExpiryAt: byId.get(r.id)?._min.endAt ?? null,
      stage: r.stage as CustomerStage,
      stageChangedAt: r.stageChangedAt,
      vip: isVip(r.netPaidCents, vipThresholdCents),
      netPaidCents: r.netPaidCents,
      paidOrderCount: r.paidOrderCount,
      firstPaidAt: r.firstPaidAt,
      lastPaidAt: r.lastPaidAt,
      serviceEndAt: r.serviceEndAt,
      lastContactAt: r.lastContactAt,
      lostReason: r.lostReason,
      lostNote: r.lostNote,
      lostReasonAt: r.lostReasonAt,
      createdAt: r.createdAt,
    }));
  }
}

// ─────────────── Controller ───────────────

@ApiTags('客户')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermissions('customer:read')
  @ApiOperation({ summary: '客户列表（按数据范围）' })
  @ApiOkResponse({ type: CustomerListDto })
  list(@Query() q: CustomerQueryDto, @CurrentUser() user: AuthUser): Promise<CustomerListDto> {
    return this.customers.list(q, user);
  }

  @Get('segments')
  @RequirePermissions('customer:read')
  @ApiOperation({ summary: '客户分层统计：各阶段人数、VIP、待召回、流失原因' })
  @ApiOkResponse({ type: CustomerSegmentsDto })
  segments(@CurrentUser() user: AuthUser): Promise<CustomerSegmentsDto> {
    return this.customers.segments(user);
  }

  @Get(':id')
  @RequirePermissions('customer:read')
  @ApiOperation({ summary: '客户详情（含跟进记录）' })
  @ApiOkResponse({ type: CustomerDetailDto })
  get(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<CustomerDetailDto> {
    return this.customers.get(id, user);
  }

  @Post()
  @RequirePermissions('customer:write')
  @Audit('customer.create', '新增客户')
  @ApiOperation({ summary: '新增客户' })
  @ApiOkResponse({ type: CustomerDto })
  create(@Body() dto: CreateCustomerDto, @CurrentUser() user: AuthUser): Promise<CustomerDto> {
    return this.customers.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('customer:write')
  @Audit('customer.update', '修改客户')
  @ApiOperation({ summary: '修改客户资料' })
  @ApiOkResponse({ type: CustomerDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CustomerDto> {
    return this.customers.update(id, dto, user);
  }

  @Post(':id/transfer')
  @RequirePermissions('customer:write')
  @Audit('customer.transfer', '更换客户负责人')
  @ApiOperation({ summary: '更换负责人（名下订阅一起转）' })
  @ApiOkResponse({ type: CustomerDetailDto })
  transfer(
    @Param('id') id: string,
    @Body() dto: TransferCustomerDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CustomerDetailDto> {
    return this.customers.transfer(id, dto.ownerId, user);
  }

  @Delete(':id')
  @RequirePermissions('customer:write')
  @Audit('customer.delete', '删除客户')
  @ApiOperation({ summary: '删除客户（只能删没有订单的）' })
  @ApiOkResponse({ type: OkDto })
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<OkDto> {
    await this.customers.remove(id, user);
    return { ok: true };
  }

  @Post(':id/follow-ups')
  @RequirePermissions('customer:write')
  @Audit('customer.follow_up', '记录客户跟进')
  @ApiOperation({ summary: '记录跟进 / 续费提醒' })
  @ApiOkResponse({ type: FollowUpDto })
  addFollowUp(
    @Param('id') id: string,
    @Body() dto: CreateFollowUpDto,
    @CurrentUser() user: AuthUser,
  ): Promise<FollowUpDto> {
    return this.customers.addFollowUp(id, dto, user);
  }

  @Post(':id/lost-reason')
  @RequirePermissions('customer:write')
  @Audit('customer.lost_reason', '记录客户流失原因')
  @ApiOperation({ summary: '记录流失原因（客户之后再付款会自动清掉）' })
  @ApiOkResponse({ type: CustomerDetailDto })
  setLostReason(
    @Param('id') id: string,
    @Body() dto: LostReasonDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CustomerDetailDto> {
    return this.customers.setLostReason(id, dto, user);
  }
}

@Module({
  imports: [SettingsModule],
  providers: [CustomersService],
  controllers: [CustomersController],
  exports: [CustomersService],
})
export class CustomersModule {}
