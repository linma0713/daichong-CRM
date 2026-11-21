import { Injectable } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import type { Order, Prisma } from '@prisma/client';
import {
  PAYMENT_METHOD_VALUES,
  REFERRAL_REWARD_STATUSES,
  REWARD_DISCOUNT,
  displayNo,
  formatCents,
  type ReferralRewardStatus,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/auth-user';
import {
  CustomerBriefDto,
  UserBriefDto,
  customerBriefSelect,
  toCustomerBrief,
  userBriefSelect,
} from '../common/briefs';
import { badRequest, notFound } from '../common/errors';
import { PageQueryDto, skipTake } from '../common/pagination';
import { NotifyService } from '../notify/notify';
import { SettingsService } from '../settings/settings';

/**
 * 转介绍奖励。单独一个文件：订单收款、退款审批要调用它，避免和渠道模块互相引用。
 */

type Tx = Prisma.TransactionClient;
const REWARD_METHODS = [...PAYMENT_METHOD_VALUES, REWARD_DISCOUNT];

export class RewardQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: REFERRAL_REWARD_STATUSES })
  @IsOptional()
  @IsIn(REFERRAL_REWARD_STATUSES)
  status?: ReferralRewardStatus;

  @ApiPropertyOptional({ description: '推荐人' })
  @IsOptional()
  @IsString()
  referrerId?: string;
}

export class ReferralRewardDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'Y00001' }) code: string;
  @ApiProperty({ type: CustomerBriefDto, description: '推荐人（拿奖励的老客户）' })
  referrer: CustomerBriefDto;
  @ApiProperty({ type: CustomerBriefDto, description: '被推荐的新客户' }) referee: CustomerBriefDto;
  @ApiProperty() orderId: string;
  @ApiProperty() orderCode: string;
  @ApiProperty() amountCents: number;
  @ApiProperty({ enum: REFERRAL_REWARD_STATUSES }) status: ReferralRewardStatus;
  @ApiProperty({ type: String, nullable: true }) method: string | null;
  @ApiProperty({ type: String, nullable: true }) reference: string | null;
  @ApiProperty({ type: String, nullable: true }) paidAt: Date | null;
  @ApiProperty({ type: UserBriefDto, nullable: true }) paidBy: UserBriefDto | null;
  @ApiProperty({ type: String, nullable: true }) cancelReason: string | null;
  @ApiProperty() createdAt: Date;
}

export class RewardListDto {
  @ApiProperty({ type: [ReferralRewardDto] }) items: ReferralRewardDto[];
  @ApiProperty() total: number;
  @ApiProperty({ description: '待发放合计（分）' }) pendingCents: number;
  @ApiProperty({ description: '待发放条数' }) pendingCount: number;
}

export class PayRewardDto {
  @ApiProperty({
    enum: REWARD_METHODS,
    description: '发放方式：收款方式之一，或 discount 抵扣续费（下次下单时填优惠）',
  })
  @IsIn(REWARD_METHODS, { message: '请选择发放方式' })
  method: string;

  @ApiPropertyOptional({ description: '转账单号 / 备注' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;

  @ApiPropertyOptional({ description: '发放时间，不填为现在' })
  @IsOptional()
  @IsDateString()
  paidAt?: string;
}

export class CancelRewardDto {
  @ApiProperty({ example: '推荐人自己说不用了' })
  @IsString()
  @IsNotEmpty({ message: '请填写作废原因' })
  @MaxLength(200)
  reason: string;
}

// ─────────────── 转介绍奖励 ───────────────

const rewardInclude = {
  referrer: { select: customerBriefSelect },
  referee: { select: customerBriefSelect },
  order: { select: { no: true } },
  paidBy: { select: userBriefSelect },
} satisfies Prisma.ReferralRewardInclude;
type RewardRow = Prisma.ReferralRewardGetPayload<{ include: typeof rewardInclude }>;

function toRewardDto(r: RewardRow): ReferralRewardDto {
  return {
    id: r.id,
    code: displayNo('Y', r.no),
    referrer: toCustomerBrief(r.referrer),
    referee: toCustomerBrief(r.referee),
    orderId: r.orderId,
    orderCode: displayNo('D', r.order.no),
    amountCents: r.amountCents,
    status: r.status as ReferralRewardStatus,
    method: r.method,
    reference: r.reference,
    paidAt: r.paidAt,
    paidBy: r.paidBy,
    cancelReason: r.cancelReason,
    createdAt: r.createdAt,
  };
}

@Injectable()
export class ReferralService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly notify: NotifyService,
  ) {}

  /** 订单收齐款：如果是被推荐客户的第一单，给推荐人生成一条待发放的奖励 */
  async onOrderPaid(tx: Tx, order: Pick<Order, 'id' | 'no' | 'customerId'>): Promise<void> {
    const { referralRewardCents } = await this.settings.getAll();
    if (referralRewardCents <= 0) return;
    const customer = await tx.customer.findUniqueOrThrow({
      where: { id: order.customerId },
      select: {
        no: true,
        name: true,
        referrer: { select: { id: true, no: true, name: true, deletedAt: true } },
      },
    });
    const referrer = customer.referrer;
    if (!referrer || referrer.deletedAt) return;
    const earlier = await tx.order.count({
      where: { customerId: order.customerId, paidAt: { not: null }, id: { not: order.id } },
    });
    if (earlier > 0) return;
    const exists = await tx.referralReward.findUnique({ where: { refereeId: order.customerId } });
    if (exists) return;
    const reward = await tx.referralReward.create({
      data: {
        referrerId: referrer.id,
        refereeId: order.customerId,
        orderId: order.id,
        amountCents: referralRewardCents,
      },
    });
    await this.notify.emit(tx, {
      event: 'referral.created',
      title: `转介绍奖励待发放 ${formatCents(referralRewardCents)} · ${displayNo('Y', reward.no)}`,
      body: `推荐人：${referrer.name}（${displayNo('C', referrer.no)}）\n新客户：${customer.name}（${displayNo(
        'C',
        customer.no,
      )}）首单 ${displayNo('D', order.no)} 已收齐款`,
      link: '/marketing?tab=rewards',
      toPermission: 'marketing:write',
    });
  }

  /** 首单全额退款：还没发的奖励自动作废（已发的不动，需要的话人工处理） */
  async onOrderRefunded(tx: Tx, orderId: string): Promise<void> {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { paidCents: true, refundedCents: true },
    });
    if (order.refundedCents < order.paidCents) return;
    await tx.referralReward.updateMany({
      where: { orderId, status: 'PENDING' },
      data: { status: 'CANCELLED', cancelReason: '新客户首单已全额退款' },
    });
  }

  async list(q: RewardQueryDto): Promise<RewardListDto> {
    const where: Prisma.ReferralRewardWhereInput = {
      status: q.status,
      referrerId: q.referrerId,
    };
    const [rows, total, pending] = await Promise.all([
      this.prisma.referralReward.findMany({
        where,
        include: rewardInclude,
        orderBy: [{ createdAt: 'desc' }],
        ...skipTake(q),
      }),
      this.prisma.referralReward.count({ where }),
      this.prisma.referralReward.aggregate({
        where: { status: 'PENDING' },
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
    ]);
    return {
      items: rows.map(toRewardDto),
      total,
      pendingCents: pending._sum.amountCents ?? 0,
      pendingCount: pending._count._all,
    };
  }

  async pay(id: string, dto: PayRewardDto, user: AuthUser): Promise<ReferralRewardDto> {
    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
    if (paidAt.getTime() > Date.now() + 60_000) throw badRequest('发放时间不能晚于现在');
    return this.settle(id, {
      status: 'PAID',
      method: dto.method,
      reference: dto.reference?.trim() || null,
      paidAt,
      paidById: user.id,
    });
  }

  cancel(id: string, reason: string): Promise<ReferralRewardDto> {
    const cancelReason = reason.trim();
    if (!cancelReason) throw badRequest('请填写作废原因');
    return this.settle(id, { status: 'CANCELLED', cancelReason });
  }

  /** 只改待发放的：两个人同时点也只会成功一次 */
  private async settle(
    id: string,
    data: Prisma.ReferralRewardUncheckedUpdateManyInput,
  ): Promise<ReferralRewardDto> {
    const r = await this.prisma.referralReward.findUnique({ where: { id } });
    if (!r) throw notFound('奖励');
    const { count } = await this.prisma.referralReward.updateMany({
      where: { id, status: 'PENDING' },
      data,
    });
    if (count === 0) throw badRequest('只有待发放的奖励可以发放或作废');
    return toRewardDto(
      await this.prisma.referralReward.findUniqueOrThrow({ where: { id }, include: rewardInclude }),
    );
  }
}
