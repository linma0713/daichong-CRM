import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  Param,
  Patch,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
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
import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import {
  FULFILLMENT_TYPES,
  ORDER_STATUSES,
  SUBSCRIPTION_STATUSES,
  TICKET_STATUSES,
  TICKET_TYPES,
  displayNo,
  hasPermission,
  parseNo,
  type FulfillmentType,
  type OrderKind,
  type OrderStatus,
  type SubscriptionStatus,
  type TicketStatus,
  type TicketType,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Audit, CurrentUser, RequireAnyPermission, RequirePermissions } from '../auth/decorators';
import type { AuthUser } from '../common/auth-user';
import {
  AccountBriefDto,
  CustomerBriefDto,
  UserBriefDto,
  accountBriefSelect,
  customerBriefSelect,
  toAccountBrief,
  userBriefSelect,
} from '../common/briefs';
import { scopeWhere } from '../common/data-scope';
import { addDays } from '../common/dates';
import { badRequest, notFound } from '../common/errors';
import { PageQueryDto } from '../common/pagination';
import { SecretBox } from '../common/secret-box';
import { productName } from '../catalog/catalog';
import { FollowUpDto, visibleCustomers } from '../customers/customers';
import { RefDto, TaskBriefDto, toCustomerBrief } from '../orders/orders';
import { SettingsModule, SettingsService } from '../settings/settings';
import { orderForPeriod } from '../inventory/ledger';
import { WarrantyDto, loadWarranty } from '../aftersales/warranty';
import { EXPIRED_FOLLOW_DAYS, daysLeft, needsReminder } from './reminder';

const toBool = ({ value }: { value: unknown }) => value === true || value === 'true';

// ─────────────── DTO ───────────────

export class SubscriptionQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '订阅编号、客户称呼或账号邮箱' })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({ enum: SUBSCRIPTION_STATUSES, enumName: 'SubscriptionStatus' })
  @IsOptional()
  @IsIn(SUBSCRIPTION_STATUSES)
  status?: SubscriptionStatus;

  @ApiPropertyOptional({ enum: FULFILLMENT_TYPES, enumName: 'FulfillmentType' })
  @IsOptional()
  @IsIn(FULFILLMENT_TYPES)
  fulfillmentType?: FulfillmentType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional({ description: '负责客服' })
  @IsOptional()
  @IsString()
  ownerId?: string;

  @ApiPropertyOptional({ description: '只看 N 天内到期（服务中）的' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  expiringDays?: number;

  @ApiPropertyOptional({ description: '只看需要提醒续费的（按业务设置里的提醒节奏）' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  needsReminder?: boolean;
}

export class UpdateSubscriptionDto {
  @ApiPropertyOptional({ description: '服务到期时间' })
  @IsOptional()
  @IsDateString()
  endAt?: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: '上游下次扣费时间' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsDateString()
  upstreamRenewAt?: string | null;

  @ApiPropertyOptional({ description: '上游自动续订是否开着' })
  @IsOptional()
  @IsBoolean()
  autoRenewOn?: boolean;

  @ApiPropertyOptional({ enum: SUBSCRIPTION_STATUSES, enumName: 'SubscriptionStatus' })
  @IsOptional()
  @IsIn(SUBSCRIPTION_STATUSES)
  status?: SubscriptionStatus;

  @ApiProperty({ description: '修改原因（记入操作日志）', example: '上游实际扣费日是 12 月 3 日' })
  @IsString()
  @IsNotEmpty({ message: '请填写修改原因' })
  @MaxLength(200)
  reason: string;
}

export class SubscriptionDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'S00012' }) code: string;
  @ApiProperty({ type: CustomerBriefDto }) customer: CustomerBriefDto;
  @ApiProperty({ type: AccountBriefDto }) account: AccountBriefDto;
  @ApiProperty() planId: string;
  @ApiProperty() planName: string;
  @ApiProperty({ enum: FULFILLMENT_TYPES, enumName: 'FulfillmentType' })
  fulfillmentType: FulfillmentType;
  @ApiProperty({ enum: SUBSCRIPTION_STATUSES, enumName: 'SubscriptionStatus' })
  status: SubscriptionStatus;
  @ApiProperty() startAt: Date;
  @ApiProperty() endAt: Date;
  @ApiProperty({ type: String, nullable: true }) upstreamRenewAt: Date | null;
  @ApiProperty() autoRenewOn: boolean;
  @ApiProperty({ type: UserBriefDto, description: '负责续费提醒的客服' }) owner: UserBriefDto;
  @ApiProperty({ description: '剩余天数；0 = 今天到期，负数 = 已到期天数' }) daysLeft: number;
  @ApiProperty({ description: '是否需要提醒客户续费' }) needsReminder: boolean;
  @ApiProperty({ type: String, nullable: true }) lastRemindedAt: Date | null;
  @ApiProperty({ type: RefDto, nullable: true, description: '未完成的续费订单' })
  openRenewalOrder: RefDto | null;
  @ApiProperty() createdAt: Date;
}

export class SubscriptionListDto {
  @ApiProperty({ type: [SubscriptionDto] }) items: SubscriptionDto[];
  @ApiProperty() total: number;
}

export class SubscriptionOrderDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty({ enum: ['NEW', 'RENEWAL'], enumName: 'OrderKind' }) kind: OrderKind;
  @ApiProperty({ enum: ORDER_STATUSES, enumName: 'OrderStatus' }) status: OrderStatus;
  @ApiProperty() productName: string;
  @ApiProperty() amountCents: number;
  @ApiProperty({ description: '加购了质保' }) withWarranty: boolean;
  @ApiProperty() createdAt: Date;
}

export class SubscriptionTicketDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty({ enum: TICKET_TYPES, enumName: 'TicketType' }) type: TicketType;
  @ApiProperty({ enum: TICKET_STATUSES, enumName: 'TicketStatus' }) status: TicketStatus;
  @ApiProperty() description: string;
  @ApiProperty() createdAt: Date;
}

export class SubscriptionDetailDto extends SubscriptionDto {
  @ApiProperty({ type: [SubscriptionOrderDto] }) orders: SubscriptionOrderDto[];
  @ApiProperty({ type: [TaskBriefDto] }) tasks: TaskBriefDto[];
  @ApiProperty({ type: [FollowUpDto], description: '续费提醒记录' }) reminders: FollowUpDto[];
  @ApiProperty({ type: WarrantyDto, description: '按现在判断的质保情况' }) warranty: WarrantyDto;
  @ApiProperty({ type: [SubscriptionTicketDto], description: '售后工单' })
  tickets: SubscriptionTicketDto[];
}

export class AccountSecretDto {
  @ApiProperty() email: string;
  @ApiProperty({ type: String, nullable: true }) password: string | null;
  @ApiProperty({ type: String, nullable: true }) secretNote: string | null;
}

export class UpdateAccountDto {
  @ApiPropertyOptional({ description: '新密码（加密保存）；传空字符串表示清除' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  password?: string;

  @ApiPropertyOptional({ description: '其他敏感信息（加密保存）；传空字符串表示清除' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  secretNote?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

// ─────────────── Service ───────────────

const subscriptionInclude = {
  customer: { select: customerBriefSelect },
  account: { select: accountBriefSelect },
  plan: { select: { name: true } },
  owner: { select: userBriefSelect },
  followUps: {
    where: { kind: 'renewal_reminder' },
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: { createdAt: true },
  },
  orders: {
    where: { kind: 'RENEWAL', status: { in: ['PENDING_PAYMENT', 'FULFILLING'] } },
    select: { id: true, no: true },
    take: 1,
  },
} satisfies Prisma.SubscriptionInclude;
type SubscriptionRow = Prisma.SubscriptionGetPayload<{ include: typeof subscriptionInclude }>;

/** 有「查看全部账号与订阅」权限的不受数据范围限制，否则按客户负责人范围 */
export function visibleSubscriptions(user: AuthUser): Prisma.SubscriptionWhereInput {
  return hasPermission(user.permissions, 'subscription:read') ? {} : scopeWhere(user);
}

/** 可能需要提醒的订阅范围：服务中且进入提醒窗口，或到期不久 */
function reminderWindow(reminderDays: number[], now: Date): Prisma.SubscriptionWhereInput {
  const maxDays = Math.max(0, ...reminderDays);
  return {
    status: { in: ['ACTIVE', 'EXPIRED'] },
    endAt: { gte: addDays(now, -EXPIRED_FOLLOW_DAYS), lte: addDays(now, maxDays) },
  };
}

@Injectable()
export class SubscriptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async list(q: SubscriptionQueryDto, user: AuthUser): Promise<SubscriptionListDto> {
    const now = new Date();
    const { reminderDays } = await this.settings.getAll();
    const no = parseNo(q.keyword, 'S');
    const kw = q.keyword?.trim();
    const filters: Prisma.SubscriptionWhereInput[] = [
      visibleSubscriptions(user),
      {
        status: q.status,
        fulfillmentType: q.fulfillmentType,
        customerId: q.customerId,
        ownerId: q.ownerId,
      },
    ];
    if (kw) {
      filters.push({
        OR: [
          ...(no !== undefined ? [{ no }] : []),
          { customer: { name: { contains: kw, mode: 'insensitive' } } },
          { account: { email: { contains: kw, mode: 'insensitive' } } },
        ],
      });
    }
    if (q.expiringDays !== undefined) {
      filters.push({ status: 'ACTIVE', endAt: { lte: addDays(now, q.expiringDays) } });
    }
    const toDto = (r: SubscriptionRow) => this.toDto(r, reminderDays, now);

    if (q.needsReminder) {
      // 需要提醒的数量不多，取出窗口内的订阅在内存里判断
      filters.push(reminderWindow(reminderDays, now));
      const rows = await this.prisma.subscription.findMany({
        where: { AND: filters },
        include: subscriptionInclude,
        orderBy: { endAt: 'asc' },
        take: 2000,
      });
      const items = rows.map(toDto).filter((s) => s.needsReminder);
      const start = (q.page - 1) * q.pageSize;
      return { items: items.slice(start, start + q.pageSize), total: items.length };
    }

    const where = { AND: filters };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.subscription.findMany({
        where,
        include: subscriptionInclude,
        orderBy: [{ endAt: 'asc' }, { no: 'asc' }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.subscription.count({ where }),
    ]);
    return { items: rows.map(toDto), total };
  }

  /** 首页统计：需要提醒续费的订阅数 */
  async countNeedsReminder(user: AuthUser, ownerId?: string): Promise<number> {
    const now = new Date();
    const { reminderDays } = await this.settings.getAll();
    const rows = await this.prisma.subscription.findMany({
      where: { AND: [visibleSubscriptions(user), reminderWindow(reminderDays, now), { ownerId }] },
      include: subscriptionInclude,
      take: 2000,
    });
    return rows.filter((r) => this.toDto(r, reminderDays, now).needsReminder).length;
  }

  async get(id: string, user: AuthUser): Promise<SubscriptionDetailDto> {
    const now = new Date();
    const { reminderDays } = await this.settings.getAll();
    const row = await this.prisma.subscription.findFirst({
      where: { id, ...visibleSubscriptions(user) },
      include: subscriptionInclude,
    });
    if (!row) throw notFound('订阅');
    const [orders, tasks, reminders, tickets, coveringOrderId] = await Promise.all([
      this.prisma.order.findMany({
        where: { subscriptionId: id },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.fulfillmentTask.findMany({
        where: { subscriptionId: id },
        include: { assignee: { select: userBriefSelect } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.followUp.findMany({
        where: { subscriptionId: id },
        include: { user: { select: userBriefSelect } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.ticket.findMany({
        where: { subscriptionId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      orderForPeriod(this.prisma, id, now),
    ]);
    return {
      warranty: await loadWarranty(this.prisma, coveringOrderId, now, null),
      tickets: tickets.map((t) => ({
        id: t.id,
        code: displayNo('G', t.no),
        type: t.type,
        status: t.status,
        description: t.description,
        createdAt: t.createdAt,
      })),
      ...this.toDto(row, reminderDays, now),
      orders: orders.map((o) => ({
        id: o.id,
        code: displayNo('D', o.no),
        kind: o.kind,
        status: o.status,
        productName: productName(o.planName, o.termMonths, o.fulfillmentType),
        amountCents: o.amountCents,
        withWarranty: o.withWarranty,
        createdAt: o.createdAt,
      })),
      tasks: tasks.map((t) => ({
        id: t.id,
        code: displayNo('T', t.no),
        type: t.type,
        status: t.status,
        assignee: t.assignee,
        dueAt: t.dueAt,
        finishedAt: t.finishedAt,
        note: t.note,
      })),
      reminders: reminders.map((f) => ({
        id: f.id,
        kind: f.kind,
        content: f.content,
        user: f.user,
        subscriptionId: f.subscriptionId,
        createdAt: f.createdAt,
      })),
    };
  }

  /** 手动校正（例如上游实际扣费日和系统算的不一样） */
  async update(
    id: string,
    dto: UpdateSubscriptionDto,
    user: AuthUser,
  ): Promise<SubscriptionDetailDto> {
    const sub = await this.prisma.subscription.findUnique({ where: { id } });
    if (!sub) throw notFound('订阅');
    const endAt = dto.endAt ? new Date(dto.endAt) : undefined;
    if (endAt && endAt.getTime() <= sub.startAt.getTime()) {
      throw badRequest('到期时间要晚于开始时间');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.subscription.update({
        where: { id },
        data: {
          endAt,
          upstreamRenewAt:
            dto.upstreamRenewAt === undefined
              ? undefined
              : dto.upstreamRenewAt === null
                ? null
                : new Date(dto.upstreamRenewAt),
          autoRenewOn: dto.autoRenewOn,
          status: dto.status,
        },
      });
      // 手动终止订阅：未完成的系统任务一并作废
      if (dto.status === 'CANCELLED') {
        await tx.fulfillmentTask.updateMany({
          where: {
            subscriptionId: id,
            type: { in: ['INTERNAL_RENEW', 'CANCEL_AUTO_RENEW', 'RECLAIM_ACCOUNT'] },
            status: { in: ['PENDING', 'IN_PROGRESS', 'FAILED'] },
          },
          data: {
            status: 'CANCELLED',
            note: `订阅已手动终止：${dto.reason}`,
            finishedAt: new Date(),
          },
        });
      }
    });
    return this.get(id, user);
  }

  private toDto(r: SubscriptionRow, reminderDays: number[], now: Date): SubscriptionDto {
    const lastRemindedAt = r.followUps[0]?.createdAt ?? null;
    const openRenewal = r.orders[0] ?? null;
    return {
      id: r.id,
      code: displayNo('S', r.no),
      customer: toCustomerBrief(r.customer),
      account: toAccountBrief(r.account),
      planId: r.planId,
      planName: r.plan.name,
      fulfillmentType: r.fulfillmentType,
      status: r.status,
      startAt: r.startAt,
      endAt: r.endAt,
      upstreamRenewAt: r.upstreamRenewAt,
      autoRenewOn: r.autoRenewOn,
      owner: r.owner,
      daysLeft: daysLeft(r.endAt, now),
      needsReminder: needsReminder(
        { status: r.status, endAt: r.endAt, lastRemindedAt, hasOpenRenewal: !!openRenewal },
        reminderDays,
        now,
      ),
      lastRemindedAt,
      openRenewalOrder: openRenewal
        ? { id: openRenewal.id, code: displayNo('D', openRenewal.no) }
        : null,
      createdAt: r.createdAt,
    };
  }
}

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBox,
    private readonly audit: AuditService,
  ) {}

  /** 查看明文密码：每次都记操作日志 */
  async reveal(id: string, user: AuthUser, req: Request): Promise<AccountSecretDto> {
    const account = await this.prisma.claudeAccount.findUnique({ where: { id } });
    if (!account) throw notFound('账号');
    await this.audit.record({
      action: 'account.secret_view',
      summary: '查看账号密码',
      userId: user.id,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      resourceId: id,
      detail: { email: account.email },
      ip: req.ip ?? null,
    });
    return {
      email: account.email,
      password: account.passwordEnc ? this.secrets.decrypt(account.passwordEnc) : null,
      secretNote: account.secretNoteEnc ? this.secrets.decrypt(account.secretNoteEnc) : null,
    };
  }

  async update(id: string, dto: UpdateAccountDto, user: AuthUser): Promise<AccountBriefDto> {
    const account = await this.prisma.claudeAccount.findUnique({ where: { id } });
    if (!account) throw notFound('账号');
    // 客服只能改自己客户名下的账号；充值员可以改所有账号
    if (!hasPermission(user.permissions, 'fulfillment:handle')) {
      const visible =
        account.customerId &&
        (await this.prisma.customer.findFirst({
          where: { id: account.customerId, ...visibleCustomers(user) },
          select: { id: true },
        }));
      if (!visible)
        throw new ForbiddenException({ code: 'FORBIDDEN', message: '你不能修改这个账号' });
    }
    const updated = await this.prisma.claudeAccount.update({
      where: { id },
      data: {
        ...(dto.password !== undefined
          ? { passwordEnc: this.secrets.encryptOptional(dto.password) }
          : {}),
        ...(dto.secretNote !== undefined
          ? { secretNoteEnc: this.secrets.encryptOptional(dto.secretNote) }
          : {}),
        ...(dto.remark !== undefined ? { remark: dto.remark.trim() || null } : {}),
      },
      select: accountBriefSelect,
    });
    return toAccountBrief(updated);
  }
}

// ─────────────── Controller ───────────────

@ApiTags('订阅与到期')
@ApiBearerAuth()
@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subs: SubscriptionsService) {}

  @Get()
  @RequireAnyPermission('customer:read', 'subscription:read')
  @ApiOperation({ summary: '订阅列表（到期提醒、即将到期）' })
  @ApiOkResponse({ type: SubscriptionListDto })
  list(
    @Query() q: SubscriptionQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<SubscriptionListDto> {
    return this.subs.list(q, user);
  }

  @Get(':id')
  @RequireAnyPermission('customer:read', 'subscription:read')
  @ApiOperation({ summary: '订阅详情（订单、任务、提醒记录）' })
  @ApiOkResponse({ type: SubscriptionDetailDto })
  get(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<SubscriptionDetailDto> {
    return this.subs.get(id, user);
  }

  @Patch(':id')
  @RequirePermissions('fulfillment:handle')
  @Audit('subscription.update', '手动校正订阅')
  @ApiOperation({ summary: '手动校正订阅（到期时间、上游扣费时间、自动续订、状态）' })
  @ApiOkResponse({ type: SubscriptionDetailDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSubscriptionDto,
    @CurrentUser() user: AuthUser,
  ): Promise<SubscriptionDetailDto> {
    return this.subs.update(id, dto, user);
  }
}

@ApiTags('订阅与到期')
@ApiBearerAuth()
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get(':id/secret')
  @RequirePermissions('account:secret:view')
  @ApiOperation({ summary: '查看账号密码等敏感信息（每次查看都记录操作日志）' })
  @ApiOkResponse({ type: AccountSecretDto })
  reveal(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ): Promise<AccountSecretDto> {
    return this.accounts.reveal(id, user, req);
  }

  @Patch(':id')
  @RequireAnyPermission('fulfillment:handle', 'customer:write')
  @Audit('account.update', '修改账号信息')
  @ApiOperation({ summary: '修改账号密码、敏感信息或备注' })
  @ApiOkResponse({ type: AccountBriefDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAccountDto,
    @CurrentUser() user: AuthUser,
  ): Promise<AccountBriefDto> {
    return this.accounts.update(id, dto, user);
  }
}

@Module({
  imports: [SettingsModule],
  providers: [SubscriptionsService, AccountsService],
  controllers: [SubscriptionsController, AccountsController],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
