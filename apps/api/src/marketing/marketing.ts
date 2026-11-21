import {
  Body,
  Controller,
  Delete,
  Get,
  Global,
  HttpCode,
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
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type { Prisma } from '@prisma/client';
import { CHANNEL_PLATFORM_VALUES, CUSTOMER_SOURCES, roi, type ChannelPlatform } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { Audit, CurrentUser, RequireAnyPermission, RequirePermissions } from '../auth/decorators';
import type { AuthUser } from '../common/auth-user';
import { UserBriefDto, userBriefSelect } from '../common/briefs';
import { localDateKey, parseLocalDate } from '../common/dates';
import { badRequest, notFound } from '../common/errors';
import { OkDto } from '../auth/auth.dto';
import { DateRangeQueryDto, parseRange } from '../finance/finance';
import { visibleCustomers } from '../customers/customers';
import { SettingsModule } from '../settings/settings';
import {
  CancelRewardDto,
  PayRewardDto,
  ReferralRewardDto,
  ReferralService,
  RewardListDto,
  RewardQueryDto,
} from './referral';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SOURCE_LABELS: Record<string, string> = Object.fromEntries(
  CUSTOMER_SOURCES.map((s) => [s.value, s.label]),
);

// ─────────────── DTO ───────────────

export class ChannelDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: CHANNEL_PLATFORM_VALUES }) platform: string;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty() enabled: boolean;
  @ApiProperty({ description: '标了这个渠道的客户数' }) customerCount: number;
  @ApiProperty({ description: '累计投放成本（分）' }) costCents: number;
  @ApiProperty() createdAt: Date;
}

export class CreateChannelDto {
  @ApiProperty({ example: '小红书-主号' })
  @IsString()
  @IsNotEmpty({ message: '请输入渠道名称' })
  @MaxLength(40)
  name: string;

  @ApiProperty({ enum: CHANNEL_PLATFORM_VALUES })
  @IsIn(CHANNEL_PLATFORM_VALUES, { message: '请选择平台' })
  platform: ChannelPlatform;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class UpdateChannelDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  name?: string;

  @ApiPropertyOptional({ enum: CHANNEL_PLATFORM_VALUES })
  @IsOptional()
  @IsIn(CHANNEL_PLATFORM_VALUES)
  platform?: ChannelPlatform;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class ChannelCostQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  channelId?: string;

  @ApiPropertyOptional({ example: '2026-11-01' })
  @IsOptional()
  @Matches(DATE_RE)
  from?: string;

  @ApiPropertyOptional({ example: '2026-11-30' })
  @IsOptional()
  @Matches(DATE_RE)
  to?: string;
}

export class CreateChannelCostDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: '请选择渠道' })
  channelId: string;

  @ApiProperty({ example: '2026-11-20', description: '花费日期（北京时间）' })
  @Matches(DATE_RE, { message: '日期格式应为 YYYY-MM-DD' })
  spentOn: string;

  @ApiProperty({ description: '金额（分）', example: 50000 })
  @IsInt()
  @Min(1, { message: '金额必须大于 0' })
  @Max(1_000_000_000)
  amountCents: number;

  @ApiPropertyOptional({ example: '薯条加热 3 天' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class ChannelCostDto {
  @ApiProperty() id: string;
  @ApiProperty() channelId: string;
  @ApiProperty() channelName: string;
  @ApiProperty({ example: '2026-11-20' }) spentOn: string;
  @ApiProperty() amountCents: number;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty({ type: UserBriefDto }) createdBy: UserBriefDto;
  @ApiProperty() createdAt: Date;
}

export class ChannelCostListDto {
  @ApiProperty({ type: [ChannelCostDto] }) items: ChannelCostDto[];
  @ApiProperty() totalCents: number;
}

export class FunnelRowDto {
  @ApiProperty({ description: '渠道 ID / 来源值；未标渠道为 none' }) key: string;
  @ApiProperty() label: string;
  @ApiProperty({ type: String, nullable: true, description: '平台（只有渠道行有）' })
  platform: string | null;
  @ApiProperty({ description: '区间内新建档的客户数' }) leads: number;
  @ApiProperty({ description: '其中已成交（收齐过款）的' }) converted: number;
  @ApiProperty({ description: '其中复购（收齐款的订单 ≥ 2）的' }) repeat: number;
  @ApiProperty({ description: '其中现在还在服务中的（新客 / 活跃）' }) active: number;
  @ApiProperty({ type: Number, nullable: true, description: '成交率' }) conversionRate:
    number | null;
  @ApiProperty({ type: Number, nullable: true, description: '复购率（复购 ÷ 成交）' })
  repeatRate: number | null;
  @ApiProperty({ description: '这些客户到目前的累计实付（分）' }) revenueCents: number;
  @ApiProperty({ description: '区间内的投放成本（分），只有渠道行有' }) costCents: number;
  @ApiProperty({ type: Number, nullable: true, description: '获客成本 = 投放成本 ÷ 成交数' })
  cacCents: number | null;
  @ApiProperty({ type: Number, nullable: true, description: '投资回报率 = (收入 − 成本) ÷ 成本' })
  roi: number | null;
}

export class ChannelRoiDto {
  @ApiProperty() from: string;
  @ApiProperty() to: string;
  @ApiProperty({ type: FunnelRowDto, description: '合计' }) total: FunnelRowDto;
  @ApiProperty({ type: [FunnelRowDto], description: '按渠道（含「未标渠道」）' })
  byChannel: FunnelRowDto[];
  @ApiProperty({ type: [FunnelRowDto], description: '按客户来源' }) bySource: FunnelRowDto[];
  @ApiProperty({ description: '只统计了自己范围内的客户（投放成本是全部的）' })
  partialScope: boolean;
}

// ─────────────── 渠道、投放成本、渠道回报 ───────────────

interface FunnelAcc {
  leads: number;
  converted: number;
  repeat: number;
  active: number;
  revenueCents: number;
  costCents: number;
}
const emptyAcc = (): FunnelAcc => ({
  leads: 0,
  converted: 0,
  repeat: 0,
  active: 0,
  revenueCents: 0,
  costCents: 0,
});
function toRow(
  key: string,
  label: string,
  platform: string | null,
  a: FunnelAcc,
  withCost: boolean,
): FunnelRowDto {
  return {
    key,
    label,
    platform,
    ...a,
    conversionRate: a.leads ? a.converted / a.leads : null,
    repeatRate: a.converted ? a.repeat / a.converted : null,
    cacCents:
      withCost && a.costCents > 0 && a.converted ? Math.round(a.costCents / a.converted) : null,
    roi: withCost ? roi(a.revenueCents, a.costCents) : null,
  };
}

@Injectable()
export class ChannelsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<ChannelDto[]> {
    const [rows, counts, costs] = await Promise.all([
      this.prisma.channel.findMany({ orderBy: [{ enabled: 'desc' }, { createdAt: 'asc' }] }),
      this.prisma.customer.groupBy({
        by: ['channelId'],
        where: { deletedAt: null, channelId: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.channelCost.groupBy({ by: ['channelId'], _sum: { amountCents: true } }),
    ]);
    const byId = new Map(counts.map((c) => [c.channelId, c._count._all]));
    const costById = new Map(costs.map((c) => [c.channelId, c._sum.amountCents ?? 0]));
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      platform: c.platform,
      note: c.note,
      enabled: c.enabled,
      customerCount: byId.get(c.id) ?? 0,
      costCents: costById.get(c.id) ?? 0,
      createdAt: c.createdAt,
    }));
  }

  async create(dto: CreateChannelDto): Promise<ChannelDto> {
    const name = dto.name.trim();
    await this.assertUniqueName(name);
    const c = await this.prisma.channel.create({
      data: { name, platform: dto.platform, note: dto.note?.trim() || null },
    });
    return { ...c, customerCount: 0, costCents: 0 };
  }

  async update(id: string, dto: UpdateChannelDto): Promise<ChannelDto> {
    await this.find(id);
    const name = dto.name?.trim();
    if (name) await this.assertUniqueName(name, id);
    await this.prisma.channel.update({
      where: { id },
      data: {
        name,
        platform: dto.platform,
        note: dto.note === undefined ? undefined : dto.note?.trim() || null,
        enabled: dto.enabled,
      },
    });
    return (await this.list()).find((c) => c.id === id)!;
  }

  /** 只能删没用过的渠道（录错了的情况）；用过的停用即可 */
  async remove(id: string): Promise<void> {
    await this.find(id);
    const [customers, costs] = await Promise.all([
      this.prisma.customer.count({ where: { channelId: id } }),
      this.prisma.channelCost.count({ where: { channelId: id } }),
    ]);
    if (customers + costs > 0) throw badRequest('渠道已经有客户或投放成本，不能删除，可以停用');
    await this.prisma.channel.delete({ where: { id } });
  }

  async costs(q: ChannelCostQueryDto): Promise<ChannelCostListDto> {
    const from = q.from ? parseLocalDate(q.from) : null;
    const to = q.to ? parseLocalDate(q.to) : null;
    if ((q.from && !from) || (q.to && !to)) throw badRequest('日期无效');
    const where: Prisma.ChannelCostWhereInput = {
      channelId: q.channelId,
      spentOn: { gte: from ?? undefined, lte: to ?? undefined },
    };
    const [rows, sum] = await Promise.all([
      this.prisma.channelCost.findMany({
        where,
        include: { channel: { select: { name: true } }, createdBy: { select: userBriefSelect } },
        orderBy: [{ spentOn: 'desc' }, { createdAt: 'desc' }],
        take: 500,
      }),
      this.prisma.channelCost.aggregate({ where, _sum: { amountCents: true } }),
    ]);
    return {
      items: rows.map((c) => ({
        id: c.id,
        channelId: c.channelId,
        channelName: c.channel.name,
        spentOn: localDateKey(c.spentOn),
        amountCents: c.amountCents,
        note: c.note,
        createdBy: c.createdBy,
        createdAt: c.createdAt,
      })),
      totalCents: sum._sum.amountCents ?? 0,
    };
  }

  async addCost(dto: CreateChannelCostDto, user: AuthUser): Promise<ChannelCostDto> {
    const channel = await this.find(dto.channelId);
    const spentOn = parseLocalDate(dto.spentOn);
    if (!spentOn) throw badRequest('日期无效');
    if (spentOn.getTime() > Date.now()) throw badRequest('花费日期不能晚于今天');
    const c = await this.prisma.channelCost.create({
      data: {
        channelId: channel.id,
        spentOn,
        amountCents: dto.amountCents,
        note: dto.note?.trim() || null,
        createdById: user.id,
      },
      include: { createdBy: { select: userBriefSelect } },
    });
    return {
      id: c.id,
      channelId: c.channelId,
      channelName: channel.name,
      spentOn: localDateKey(c.spentOn),
      amountCents: c.amountCents,
      note: c.note,
      createdBy: c.createdBy,
      createdAt: c.createdAt,
    };
  }

  async removeCost(id: string): Promise<void> {
    const c = await this.prisma.channelCost.findUnique({ where: { id } });
    if (!c) throw notFound('投放成本');
    await this.prisma.channelCost.delete({ where: { id } });
  }

  /**
   * 渠道回报与成交漏斗：区间内新建档的客户 → 成交 → 复购，收入按这些客户到目前的累计实付算，
   * 成本按区间内的投放成本算。
   */
  async roi(q: DateRangeQueryDto, user: AuthUser): Promise<ChannelRoiDto> {
    const r = parseRange(q);
    const [channels, customers, costs] = await Promise.all([
      this.prisma.channel.findMany({ orderBy: { createdAt: 'asc' } }),
      this.prisma.customer.findMany({
        where: { ...visibleCustomers(user), createdAt: { gte: r.start, lt: r.end } },
        select: {
          channelId: true,
          source: true,
          firstPaidAt: true,
          paidOrderCount: true,
          netPaidCents: true,
          stage: true,
        },
      }),
      this.prisma.channelCost.groupBy({
        by: ['channelId'],
        where: { spentOn: { gte: r.start, lt: r.end } },
        _sum: { amountCents: true },
      }),
    ]);
    const total = emptyAcc();
    const byChannel = new Map<string, FunnelAcc>();
    const bySource = new Map<string, FunnelAcc>();
    const get = (m: Map<string, FunnelAcc>, k: string) => {
      let a = m.get(k);
      if (!a) {
        a = emptyAcc();
        m.set(k, a);
      }
      return a;
    };
    for (const c of customers) {
      for (const a of [total, get(byChannel, c.channelId ?? 'none'), get(bySource, c.source)]) {
        a.leads += 1;
        if (c.firstPaidAt) a.converted += 1;
        if (c.paidOrderCount >= 2) a.repeat += 1;
        if (c.stage === 'NEW' || c.stage === 'ACTIVE') a.active += 1;
        a.revenueCents += c.netPaidCents;
      }
    }
    for (const c of costs) {
      const amount = c._sum.amountCents ?? 0;
      get(byChannel, c.channelId).costCents += amount;
      total.costCents += amount;
    }
    const rows = channels
      .filter((c) => c.enabled || byChannel.has(c.id))
      .map((c) => toRow(c.id, c.name, c.platform, byChannel.get(c.id) ?? emptyAcc(), true));
    if (byChannel.has('none')) {
      rows.push(toRow('none', '未标渠道', null, byChannel.get('none')!, false));
    }
    return {
      from: q.from,
      to: q.to,
      total: toRow('total', '合计', null, total, true),
      byChannel: rows,
      bySource: CUSTOMER_SOURCES.filter((s) => bySource.has(s.value)).map((s) =>
        toRow(s.value, SOURCE_LABELS[s.value], null, bySource.get(s.value)!, false),
      ),
      partialScope: user.dataScope !== 'ALL',
    };
  }

  private async find(id: string) {
    const c = await this.prisma.channel.findUnique({ where: { id } });
    if (!c) throw notFound('渠道');
    return c;
  }

  private async assertUniqueName(name: string, exceptId?: string) {
    const dup = await this.prisma.channel.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        id: exceptId ? { not: exceptId } : undefined,
      },
    });
    if (dup) throw badRequest('已经有同名的渠道');
  }
}

// ─────────────── Controller ───────────────

@ApiTags('渠道与营销')
@ApiBearerAuth()
@Controller('channels')
export class ChannelsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  @ApiOperation({ summary: '渠道列表（所有员工可查看，录客户时选）' })
  @ApiOkResponse({ type: [ChannelDto] })
  list(): Promise<ChannelDto[]> {
    return this.channels.list();
  }

  @Post()
  @RequirePermissions('marketing:write')
  @Audit('channel.create', '新增渠道')
  @ApiOperation({ summary: '新增渠道' })
  @ApiOkResponse({ type: ChannelDto })
  create(@Body() dto: CreateChannelDto): Promise<ChannelDto> {
    return this.channels.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('marketing:write')
  @Audit('channel.update', '修改渠道')
  @ApiOperation({ summary: '修改 / 停用渠道' })
  @ApiOkResponse({ type: ChannelDto })
  update(@Param('id') id: string, @Body() dto: UpdateChannelDto): Promise<ChannelDto> {
    return this.channels.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('marketing:write')
  @Audit('channel.delete', '删除渠道')
  @ApiOperation({ summary: '删除渠道（只能删没用过的）' })
  @ApiOkResponse({ type: OkDto })
  async remove(@Param('id') id: string): Promise<OkDto> {
    await this.channels.remove(id);
    return { ok: true };
  }
}

@ApiTags('渠道与营销')
@ApiBearerAuth()
@Controller('channel-costs')
export class ChannelCostsController {
  constructor(private readonly channels: ChannelsService) {}

  @Get()
  @RequireAnyPermission('marketing:write', 'report:read')
  @ApiOperation({ summary: '投放成本明细（最多 500 条）' })
  @ApiOkResponse({ type: ChannelCostListDto })
  list(@Query() q: ChannelCostQueryDto): Promise<ChannelCostListDto> {
    return this.channels.costs(q);
  }

  @Post()
  @RequirePermissions('marketing:write')
  @Audit('channel.cost.create', '登记投放成本')
  @ApiOperation({ summary: '登记投放成本' })
  @ApiOkResponse({ type: ChannelCostDto })
  create(
    @Body() dto: CreateChannelCostDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ChannelCostDto> {
    return this.channels.addCost(dto, user);
  }

  @Delete(':id')
  @RequirePermissions('marketing:write')
  @Audit('channel.cost.delete', '删除投放成本')
  @ApiOperation({ summary: '删除投放成本（录错了）' })
  @ApiOkResponse({ type: OkDto })
  async remove(@Param('id') id: string): Promise<OkDto> {
    await this.channels.removeCost(id);
    return { ok: true };
  }
}

@ApiTags('渠道与营销')
@ApiBearerAuth()
@Controller('marketing')
export class MarketingController {
  constructor(private readonly channels: ChannelsService) {}

  @Get('channel-roi')
  @RequireAnyPermission('marketing:write', 'report:read')
  @ApiOperation({ summary: '渠道回报与成交漏斗（按建档日期统计）' })
  @ApiOkResponse({ type: ChannelRoiDto })
  roi(@Query() q: DateRangeQueryDto, @CurrentUser() user: AuthUser): Promise<ChannelRoiDto> {
    return this.channels.roi(q, user);
  }
}

@ApiTags('渠道与营销')
@ApiBearerAuth()
@Controller('referral-rewards')
export class ReferralRewardsController {
  constructor(private readonly referrals: ReferralService) {}

  @Get()
  @RequireAnyPermission('marketing:write', 'finance:read')
  @ApiOperation({ summary: '转介绍奖励列表' })
  @ApiOkResponse({ type: RewardListDto })
  list(@Query() q: RewardQueryDto): Promise<RewardListDto> {
    return this.referrals.list(q);
  }

  @Post(':id/pay')
  @HttpCode(200)
  @RequirePermissions('marketing:write')
  @Audit('referral.pay', '发放转介绍奖励')
  @ApiOperation({ summary: '登记发放（转账或抵扣续费）' })
  @ApiOkResponse({ type: ReferralRewardDto })
  pay(
    @Param('id') id: string,
    @Body() dto: PayRewardDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ReferralRewardDto> {
    return this.referrals.pay(id, dto, user);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('marketing:write')
  @Audit('referral.cancel', '作废转介绍奖励')
  @ApiOperation({ summary: '作废奖励' })
  @ApiOkResponse({ type: ReferralRewardDto })
  cancel(@Param('id') id: string, @Body() dto: CancelRewardDto): Promise<ReferralRewardDto> {
    return this.referrals.cancel(id, dto.reason);
  }
}

/** 全局：订单收款、退款审批时要调用转介绍奖励 */
@Global()
@Module({
  imports: [SettingsModule],
  providers: [ChannelsService, ReferralService],
  controllers: [
    ChannelsController,
    ChannelCostsController,
    MarketingController,
    ReferralRewardsController,
  ],
  exports: [ReferralService],
})
export class MarketingModule {}
