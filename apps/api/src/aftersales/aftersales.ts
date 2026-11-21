import {
  Body,
  Controller,
  Get,
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
import { Transform } from 'class-transformer';
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
import { Prisma, type Order, type Ticket } from '@prisma/client';
import {
  ALL_PERMISSIONS,
  CUSTOMER_FAULT_VALUES,
  FULFILLMENT_TYPES,
  PAYMENT_METHODS,
  PAYMENT_METHOD_VALUES,
  REFUND_STATUSES,
  SUBSCRIPTION_STATUSES,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  TICKET_TYPES,
  TICKET_TYPE_LABELS,
  displayNo,
  formatCents,
  parseNo,
  type CustomerFault,
  type FulfillmentType,
  type PaymentMethod,
  type RefundStatus,
  type SubscriptionStatus,
  type TaskStatus,
  type TicketStatus,
  type TicketType,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { Audit, CurrentUser, RequireAnyPermission, RequirePermissions } from '../auth/decorators';
import type { AuthUser } from '../common/auth-user';
import {
  CustomerBriefDto,
  UserBriefDto,
  customerBriefSelect,
  userBriefSelect,
} from '../common/briefs';
import { addDays, addHours, localDateKey, localDateTimeText } from '../common/dates';
import { scopeWhere } from '../common/data-scope';
import { badRequest, notFound } from '../common/errors';
import { PageQueryDto, skipTake } from '../common/pagination';
import { visibleCustomers } from '../customers/customers';
import { RefDto, TaskBriefDto, toCustomerBrief, visibleOrders } from '../orders/orders';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { CommissionEngine } from '../commissions/engine';
import { FulfillmentService, type Tx } from '../fulfillment/fulfillment.service';
import { LedgerModule, LedgerService } from '../inventory/ledger';
import { SettingsModule, SettingsService } from '../settings/settings';
import { recordTicketEvent, resolveTicketBySystem } from './ticket-events';
import { NotifyService } from '../notify/notify';
import { CustomerStatsService } from '../customers/stats';
import { ReferralService } from '../marketing/referral';

/** 通知里引用用户写的长文字时截短 */
const brief = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max)}…` : text);
import { WarrantyDto, faultLabel, loadWarranty } from './warranty';

/** 还没解决的工单 */
const UNRESOLVED: TicketStatus[] = ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER'];
/** 计处理时限的状态（等客户回复时不算超时） */
const TIMED: TicketStatus[] = ['OPEN', 'IN_PROGRESS'];
const OPEN_TASK: TaskStatus[] = ['PENDING', 'IN_PROGRESS', 'FAILED'];

// ─────────────── DTO ───────────────

const toBool = ({ value }: { value: unknown }) => value === true || value === 'true';

export class TicketQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: ['open', 'closed', 'all'],
    default: 'open',
    description: 'open 未解决（待处理 / 处理中 / 等客户回复）；closed 已解决或已关闭',
  })
  @IsOptional()
  @IsIn(['open', 'closed', 'all'])
  view?: 'open' | 'closed' | 'all';

  @ApiPropertyOptional({ enum: TICKET_STATUSES, enumName: 'TicketStatus' })
  @IsOptional()
  @IsIn(TICKET_STATUSES)
  status?: TicketStatus;

  @ApiPropertyOptional({ enum: TICKET_TYPES, enumName: 'TicketType' })
  @IsOptional()
  @IsIn(TICKET_TYPES)
  type?: TicketType;

  @ApiPropertyOptional({ description: 'me 我处理的；unassigned 没人处理的；或员工 ID' })
  @IsOptional()
  @IsString()
  assignee?: string;

  @ApiPropertyOptional({ description: '只看已超时的' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  overdue?: boolean;

  @ApiPropertyOptional({ description: '工单编号、客户称呼或账号邮箱' })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subscriptionId?: string;
}

export class CreateTicketDto {
  @ApiProperty()
  @IsString()
  customerId: string;

  @ApiPropertyOptional({ description: '出问题的订阅（换号、补偿、按质保退款都要选）' })
  @IsOptional()
  @IsString()
  subscriptionId?: string;

  @ApiProperty({ enum: TICKET_TYPES, enumName: 'TicketType' })
  @IsIn(TICKET_TYPES)
  type: TicketType;

  @ApiProperty({ example: '客户反馈登录提示账号被停用' })
  @IsString()
  @IsNotEmpty({ message: '请描述问题' })
  @MaxLength(1000)
  description: string;
}

export class UpdateTicketDto {
  @ApiPropertyOptional({
    enum: ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER'],
    description: '解决、关闭、重新打开用单独的接口',
  })
  @IsOptional()
  @IsIn(['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER'])
  status?: TicketStatus;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'null = 放回待领取' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  assigneeId?: string | null;

  @ApiPropertyOptional({
    enum: CUSTOMER_FAULT_VALUES,
    nullable: true,
    description: '客户自身原因（设置后不在质保内）；null = 取消',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(CUSTOMER_FAULT_VALUES)
  customerFault?: CustomerFault | null;
}

export class TicketCommentDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: '请填写内容' })
  @MaxLength(1000)
  content: string;
}

export class ResolveTicketDto {
  @ApiProperty({ example: '客户重新登录后恢复正常' })
  @IsString()
  @IsNotEmpty({ message: '请填写处理结果' })
  @MaxLength(500)
  resolution: string;
}

export class TicketReasonDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ReopenTicketDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: '请填写重新打开的原因' })
  @MaxLength(500)
  reason: string;
}

export class CompensateDto {
  @ApiProperty({ description: '补偿天数（服务期往后延）', example: 3 })
  @IsInt()
  @Min(1)
  @Max(90)
  days: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class TicketSubscriptionDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty() planName: string;
  @ApiProperty({ enum: SUBSCRIPTION_STATUSES, enumName: 'SubscriptionStatus' })
  status: SubscriptionStatus;
  @ApiProperty({ enum: FULFILLMENT_TYPES, enumName: 'FulfillmentType' })
  fulfillmentType: FulfillmentType;
  @ApiProperty() endAt: Date;
  @ApiProperty() accountEmail: string;
}

export class TicketDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'G00012' }) code: string;
  @ApiProperty({ enum: TICKET_TYPES, enumName: 'TicketType' }) type: TicketType;
  @ApiProperty({ enum: TICKET_STATUSES, enumName: 'TicketStatus' }) status: TicketStatus;
  @ApiProperty({ type: CustomerBriefDto }) customer: CustomerBriefDto;
  @ApiProperty({ type: TicketSubscriptionDto, nullable: true })
  subscription: TicketSubscriptionDto | null;
  @ApiProperty({ type: RefDto, nullable: true, description: '质保按这笔订单算' })
  order: RefDto | null;
  @ApiProperty() description: string;
  @ApiProperty({ enum: CUSTOMER_FAULT_VALUES, nullable: true })
  customerFault: CustomerFault | null;
  @ApiProperty({ type: String, nullable: true }) customerFaultLabel: string | null;
  @ApiProperty({ type: String, nullable: true }) resolution: string | null;
  @ApiProperty({ type: UserBriefDto, nullable: true, description: '售后处理人' })
  assignee: UserBriefDto | null;
  @ApiProperty({ type: UserBriefDto, description: '客户负责人' }) owner: UserBriefDto;
  @ApiProperty({ type: UserBriefDto }) createdBy: UserBriefDto;
  @ApiProperty({ description: '处理时限' }) dueAt: Date;
  @ApiProperty({ description: '未解决且已过处理时限（等客户回复时不算）' }) overdue: boolean;
  @ApiProperty({ type: String, nullable: true, description: '超时升级的时间' })
  escalatedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) resolvedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) closedAt: Date | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class TicketListDto {
  @ApiProperty({ type: [TicketDto] }) items: TicketDto[];
  @ApiProperty() total: number;
}

export class TicketEventDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'comment' }) kind: string;
  @ApiProperty({ type: String, nullable: true }) content: string | null;
  @ApiProperty({ type: UserBriefDto, nullable: true, description: '为空 = 系统自动' })
  user: UserBriefDto | null;
  @ApiProperty() createdAt: Date;
}

export class RefundDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'K00003' }) code: string;
  @ApiProperty({ type: RefDto }) order: RefDto;
  @ApiProperty({ description: '订单已收（分）' }) orderPaidCents: number;
  @ApiProperty({ description: '订单已退（分）' }) orderRefundedCents: number;
  @ApiProperty({ type: CustomerBriefDto }) customer: CustomerBriefDto;
  @ApiProperty({ type: RefDto, nullable: true }) subscription: RefDto | null;
  @ApiProperty({ type: RefDto, nullable: true }) ticket: RefDto | null;
  @ApiProperty() amountCents: number;
  @ApiProperty() reason: string;
  @ApiProperty({ description: '退款后终止服务' }) terminate: boolean;
  @ApiProperty({ enum: REFUND_STATUSES, enumName: 'RefundStatus' }) status: RefundStatus;
  @ApiProperty({ type: UserBriefDto }) requestedBy: UserBriefDto;
  @ApiProperty({ type: UserBriefDto, nullable: true, description: '审批人' })
  approvedBy: UserBriefDto | null;
  @ApiProperty({ type: String, nullable: true }) method: string | null;
  @ApiProperty({ type: String, nullable: true }) reference: string | null;
  @ApiProperty({ type: String, nullable: true }) paidAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) rejectReason: string | null;
  @ApiProperty({ description: '这笔退款扣减的代理佣金（分），出账时计算' })
  commissionReducedCents: number;
  @ApiProperty() createdAt: Date;
}

export class RefundListDto {
  @ApiProperty({ type: [RefundDto] }) items: RefundDto[];
  @ApiProperty() total: number;
}

export class TicketDetailDto extends TicketDto {
  @ApiProperty({ type: WarrantyDto, description: '按问题登记时间判断的质保情况' })
  warranty: WarrantyDto;
  @ApiProperty({ description: '对应订单还能申请退款的金额（分）' }) refundableCents: number;
  @ApiProperty({ type: [TicketEventDto] }) events: TicketEventDto[];
  @ApiProperty({ type: [RefundDto] }) refunds: RefundDto[];
  @ApiProperty({ type: [TaskBriefDto], description: '换号任务' }) tasks: TaskBriefDto[];
}

export class RefundQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: REFUND_STATUSES, enumName: 'RefundStatus' })
  @IsOptional()
  @IsIn(REFUND_STATUSES)
  status?: RefundStatus;

  @ApiPropertyOptional({ description: '退款编号或客户称呼' })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  orderId?: string;
}

export class CreateRefundDto {
  @ApiProperty()
  @IsString()
  orderId: string;

  @ApiPropertyOptional({ description: '来自哪个售后工单' })
  @IsOptional()
  @IsString()
  ticketId?: string;

  @ApiProperty({ description: '退款金额（分）' })
  @IsInt()
  @Min(1, { message: '退款金额必须大于 0' })
  @Max(100_000_00)
  amountCents: number;

  @ApiProperty({ example: '封号，按质保剩余天数退款' })
  @IsString()
  @IsNotEmpty({ message: '请填写退款原因' })
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({
    description: '退款后终止服务：已开通的取消自动续订 / 回收成品号；还没开通的取消开通',
  })
  @IsOptional()
  @IsBoolean()
  terminate?: boolean;
}

export class ApproveRefundDto {
  @ApiProperty({ enum: PAYMENT_METHOD_VALUES, description: '退款方式' })
  @IsIn(PAYMENT_METHOD_VALUES)
  method: PaymentMethod;

  @ApiPropertyOptional({ description: '退款单号或备注' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;

  @ApiPropertyOptional({ description: '退款时间，不填为现在' })
  @IsOptional()
  @IsDateString()
  paidAt?: string;
}

export class RejectRefundDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: '请填写驳回原因' })
  @MaxLength(500)
  reason: string;
}

export class TicketSweepResult {
  escalated: number;
  closed: number;
}

// ─────────────── Service ───────────────

export function visibleTickets(user: AuthUser): Prisma.TicketWhereInput {
  return scopeWhere(user);
}

export function visibleRefunds(user: AuthUser): Prisma.RefundWhereInput {
  return scopeWhere(user);
}

const ticketInclude = {
  customer: { select: customerBriefSelect },
  subscription: {
    select: {
      id: true,
      no: true,
      status: true,
      fulfillmentType: true,
      endAt: true,
      plan: { select: { name: true } },
      account: { select: { email: true } },
    },
  },
  order: { select: { id: true, no: true } },
  assignee: { select: userBriefSelect },
  owner: { select: userBriefSelect },
  createdBy: { select: userBriefSelect },
} satisfies Prisma.TicketInclude;
type TicketRow = Prisma.TicketGetPayload<{ include: typeof ticketInclude }>;

const refundInclude = {
  order: { select: { id: true, no: true, paidCents: true, refundedCents: true } },
  customer: { select: customerBriefSelect },
  subscription: { select: { id: true, no: true } },
  ticket: { select: { id: true, no: true } },
  requestedBy: { select: userBriefSelect },
  approvedBy: { select: userBriefSelect },
} satisfies Prisma.RefundInclude;
type RefundRow = Prisma.RefundGetPayload<{ include: typeof refundInclude }>;

function isOverdue(t: { status: TicketStatus; dueAt: Date }, now: Date): boolean {
  return TIMED.includes(t.status) && t.dueAt.getTime() < now.getTime();
}

function toTicketDto(t: TicketRow, now = new Date()): TicketDto {
  const sub = t.subscription;
  return {
    id: t.id,
    code: displayNo('G', t.no),
    type: t.type,
    status: t.status,
    customer: toCustomerBrief(t.customer),
    subscription: sub
      ? {
          id: sub.id,
          code: displayNo('S', sub.no),
          planName: sub.plan.name,
          status: sub.status,
          fulfillmentType: sub.fulfillmentType,
          endAt: sub.endAt,
          accountEmail: sub.account.email,
        }
      : null,
    order: t.order ? { id: t.order.id, code: displayNo('D', t.order.no) } : null,
    description: t.description,
    customerFault: t.customerFault as CustomerFault | null,
    customerFaultLabel: faultLabel(t.customerFault),
    resolution: t.resolution,
    assignee: t.assignee,
    owner: t.owner,
    createdBy: t.createdBy,
    dueAt: t.dueAt,
    overdue: isOverdue(t, now),
    escalatedAt: t.escalatedAt,
    resolvedAt: t.resolvedAt,
    closedAt: t.closedAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

function toRefundDto(r: RefundRow): RefundDto {
  return {
    id: r.id,
    code: displayNo('K', r.no),
    order: { id: r.order.id, code: displayNo('D', r.order.no) },
    orderPaidCents: r.order.paidCents,
    orderRefundedCents: r.order.refundedCents,
    customer: toCustomerBrief(r.customer),
    subscription: r.subscription
      ? { id: r.subscription.id, code: displayNo('S', r.subscription.no) }
      : null,
    ticket: r.ticket ? { id: r.ticket.id, code: displayNo('G', r.ticket.no) } : null,
    amountCents: r.amountCents,
    reason: r.reason,
    terminate: r.terminate,
    status: r.status,
    requestedBy: r.requestedBy,
    approvedBy: r.approvedBy,
    method: r.method,
    reference: r.reference,
    paidAt: r.paidAt,
    rejectReason: r.rejectReason,
    commissionReducedCents: r.commissionReducedCents,
    createdAt: r.createdAt,
  };
}

const methodLabel = (m: string) => PAYMENT_METHODS.find((p) => p.value === m)?.label ?? m;

/** 有某个权限的在职员工（管理员除外）里，手上未完成的最少的那个 */
async function leastLoaded(
  tx: Tx,
  permission: string,
  load: (ids: string[]) => Promise<Map<string | null, number>>,
): Promise<string | null> {
  const candidates = await tx.user.findMany({
    where: {
      deletedAt: null,
      status: 'ACTIVE',
      roles: { some: { role: { permissions: { has: permission } } } },
      NOT: { roles: { some: { role: { permissions: { has: ALL_PERMISSIONS } } } } },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  if (candidates.length === 0) return null;
  const loads = await load(candidates.map((c) => c.id));
  let best = candidates[0].id;
  for (const c of candidates) {
    if ((loads.get(c.id) ?? 0) < (loads.get(best) ?? 0)) best = c.id;
  }
  return best;
}

@Injectable()
export class TicketsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly fulfillment: FulfillmentService,
    private readonly ledger: LedgerService,
    private readonly notify: NotifyService,
  ) {}

  async list(q: TicketQueryDto, user: AuthUser): Promise<TicketListDto> {
    const now = new Date();
    const view = q.view ?? 'open';
    const no = parseNo(q.keyword, 'G');
    const kw = q.keyword?.trim();
    const where: Prisma.TicketWhereInput = {
      AND: [
        visibleTickets(user),
        q.overdue ? { status: { in: TIMED }, dueAt: { lt: now } } : {},
        kw
          ? {
              OR: [
                ...(no !== undefined ? [{ no }] : []),
                { customer: { name: { contains: kw, mode: 'insensitive' } } },
                { subscription: { account: { email: { contains: kw, mode: 'insensitive' } } } },
              ],
            }
          : {},
      ],
      status:
        q.status ??
        (view === 'open'
          ? { in: UNRESOLVED }
          : view === 'closed'
            ? { in: ['RESOLVED', 'CLOSED'] }
            : undefined),
      type: q.type,
      customerId: q.customerId,
      subscriptionId: q.subscriptionId,
      assigneeId:
        q.assignee === 'me'
          ? user.id
          : q.assignee === 'unassigned'
            ? null
            : q.assignee || undefined,
    };
    const orderBy: Prisma.TicketOrderByWithRelationInput[] =
      view === 'open' ? [{ dueAt: 'asc' }, { no: 'asc' }] : [{ updatedAt: 'desc' }];
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.ticket.findMany({ where, include: ticketInclude, orderBy, ...skipTake(q) }),
      this.prisma.ticket.count({ where }),
    ]);
    return { items: rows.map((t) => toTicketDto(t, now)), total };
  }

  async get(id: string, user: AuthUser): Promise<TicketDetailDto> {
    const t = await this.prisma.ticket.findFirst({
      where: { id, ...visibleTickets(user) },
      include: {
        ...ticketInclude,
        events: { include: { user: { select: userBriefSelect } }, orderBy: { createdAt: 'asc' } },
        refunds: { include: refundInclude, orderBy: { createdAt: 'asc' } },
        tasks: {
          include: { assignee: { select: userBriefSelect } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!t) throw notFound('工单');
    const [warranty, refundableCents] = await Promise.all([
      loadWarranty(this.prisma, t.orderId, t.createdAt, t.customerFault),
      t.orderId ? refundableOf(this.prisma, t.orderId) : Promise.resolve(0),
    ]);
    return {
      ...toTicketDto(t),
      warranty,
      refundableCents,
      events: t.events.map((e) => ({
        id: e.id,
        kind: e.kind,
        content: e.content,
        user: e.user,
        createdAt: e.createdAt,
      })),
      refunds: t.refunds.map(toRefundDto),
      tasks: t.tasks.map((k) => ({
        id: k.id,
        code: displayNo('T', k.no),
        type: k.type,
        status: k.status,
        assignee: k.assignee,
        dueAt: k.dueAt,
        finishedAt: k.finishedAt,
        note: k.note,
      })),
    };
  }

  /** 登记工单：按类型定处理时限，自动派给手上工单最少的售后 */
  async create(dto: CreateTicketDto, user: AuthUser): Promise<TicketDetailDto> {
    const customer = await this.prisma.customer.findFirst({
      where: { id: dto.customerId, ...visibleCustomers(user) },
    });
    if (!customer) throw notFound('客户');
    const sub = dto.subscriptionId
      ? await this.prisma.subscription.findFirst({
          where: { id: dto.subscriptionId, customerId: customer.id },
        })
      : null;
    if (dto.subscriptionId && !sub) throw badRequest('订阅不属于这个客户');
    const { ticketSlaHours } = await this.settings.getAll();
    const now = new Date();
    const id = await this.prisma.$transaction(async (tx) => {
      const assigneeId = await this.pickAssignee(tx);
      const ticket = await tx.ticket.create({
        data: {
          type: dto.type,
          customerId: customer.id,
          subscriptionId: sub?.id ?? null,
          orderId: sub ? await this.ledger.orderForPeriod(tx, sub.id, now) : null,
          description: dto.description.trim(),
          assigneeId,
          ownerId: customer.ownerId,
          teamId: customer.teamId,
          createdById: user.id,
          dueAt: addHours(now, ticketSlaHours[dto.type]),
        },
        include: { assignee: { select: userBriefSelect } },
      });
      await recordTicketEvent(tx, {
        ticketId: ticket.id,
        kind: 'created',
        content: `登记${TICKET_TYPE_LABELS[dto.type]}工单，${
          ticket.assignee ? `自动指派给${ticket.assignee.displayName}` : '等待售后领取'
        }`,
        userId: user.id,
      });
      await this.notify.emit(tx, {
        event: 'ticket.created',
        title: `新售后工单 ${displayNo('G', ticket.no)} · ${TICKET_TYPE_LABELS[dto.type]}`,
        body: [
          `客户：${customer.name}（${displayNo('C', customer.no)}）`,
          `问题：${brief(dto.description.trim())}`,
          `处理时限：${localDateTimeText(ticket.dueAt)}`,
          `登记人：${user.displayName}`,
        ].join('\n'),
        link: `/tickets/${ticket.id}`,
        to: [assigneeId],
        toPermission: 'ticket:handle',
        except: user.id,
      });
      return ticket.id;
    });
    return this.get(id, user);
  }

  async update(id: string, dto: UpdateTicketDto, user: AuthUser): Promise<TicketDetailDto> {
    const { ticketSlaHours } = await this.settings.getAll();
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTicket(tx, id, user);
      const data: Prisma.TicketUncheckedUpdateInput = {};
      if (dto.status && dto.status !== t.status) {
        if (!UNRESOLVED.includes(t.status)) {
          throw badRequest('工单已解决或已关闭，要继续处理请先重新打开');
        }
        data.status = dto.status;
        // 等完客户回来时已经过了时限的，重新给一个完整的处理时限
        if (t.status === 'WAITING_CUSTOMER' && t.dueAt.getTime() < now.getTime()) {
          data.dueAt = addHours(now, ticketSlaHours[t.type]);
        }
        await recordTicketEvent(tx, {
          ticketId: id,
          kind: 'status',
          content: `${TICKET_STATUS_LABELS[t.status]} → ${TICKET_STATUS_LABELS[dto.status]}`,
          userId: user.id,
        });
      }
      if (dto.assigneeId !== undefined && dto.assigneeId !== t.assigneeId) {
        let name = '';
        if (dto.assigneeId) {
          const target = await tx.user.findFirst({
            where: { id: dto.assigneeId, deletedAt: null, status: 'ACTIVE' },
            include: { roles: { include: { role: { select: { permissions: true } } } } },
          });
          const perms = target?.roles.flatMap((r) => r.role.permissions) ?? [];
          if (!target || !(perms.includes('ticket:handle') || perms.includes(ALL_PERMISSIONS))) {
            throw badRequest('只能指派给有「处理售后工单」权限的在职员工');
          }
          name = target.displayName;
        }
        data.assigneeId = dto.assigneeId;
        await recordTicketEvent(tx, {
          ticketId: id,
          kind: 'assign',
          content: dto.assigneeId ? `指派给${name}` : '放回待领取',
          userId: user.id,
        });
      }
      if (dto.customerFault !== undefined && dto.customerFault !== t.customerFault) {
        data.customerFault = dto.customerFault;
        await recordTicketEvent(tx, {
          ticketId: id,
          kind: 'fault',
          content: dto.customerFault
            ? `标记为客户原因：${faultLabel(dto.customerFault)}（不在质保内）`
            : '取消客户原因标记',
          userId: user.id,
        });
      }
      if (Object.keys(data).length > 0) await tx.ticket.update({ where: { id }, data });
    });
    return this.get(id, user);
  }

  async comment(id: string, content: string, user: AuthUser): Promise<TicketDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockTicket(tx, id, user);
      await recordTicketEvent(tx, {
        ticketId: id,
        kind: 'comment',
        content: content.trim(),
        userId: user.id,
      });
      await tx.ticket.update({ where: { id }, data: { updatedAt: new Date() } });
    });
    return this.get(id, user);
  }

  async resolve(id: string, resolution: string, user: AuthUser): Promise<TicketDetailDto> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTicket(tx, id, user);
      if (!UNRESOLVED.includes(t.status)) throw badRequest('工单已经解决或关闭了');
      await tx.ticket.update({
        where: { id },
        data: {
          status: 'RESOLVED',
          resolution: resolution.trim(),
          resolvedAt: now,
          assigneeId: t.assigneeId ?? user.id,
        },
      });
      await recordTicketEvent(tx, {
        ticketId: id,
        kind: 'resolved',
        content: resolution.trim(),
        userId: user.id,
      });
    });
    return this.get(id, user);
  }

  async close(id: string, note: string | undefined, user: AuthUser): Promise<TicketDetailDto> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTicket(tx, id, user);
      if (t.status === 'CLOSED') throw badRequest('工单已经关闭了');
      await tx.ticket.update({
        where: { id },
        data: { status: 'CLOSED', closedAt: now, resolvedAt: t.resolvedAt ?? now },
      });
      await recordTicketEvent(tx, {
        ticketId: id,
        kind: 'closed',
        content: note?.trim() || '手动关闭',
        userId: user.id,
      });
    });
    return this.get(id, user);
  }

  async reopen(id: string, reason: string, user: AuthUser): Promise<TicketDetailDto> {
    const { ticketSlaHours } = await this.settings.getAll();
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTicket(tx, id, user);
      if (UNRESOLVED.includes(t.status)) throw badRequest('工单还没解决，不需要重新打开');
      await tx.ticket.update({
        where: { id },
        data: {
          status: 'IN_PROGRESS',
          resolvedAt: null,
          closedAt: null,
          escalatedAt: null,
          dueAt: addHours(now, ticketSlaHours[t.type]),
        },
      });
      await recordTicketEvent(tx, {
        ticketId: id,
        kind: 'reopened',
        content: reason.trim(),
        userId: user.id,
      });
    });
    return this.get(id, user);
  }

  /** 派换号任务给充值员；任务完成后工单自动标记已解决 */
  async replace(id: string, note: string | undefined, user: AuthUser): Promise<TicketDetailDto> {
    const { activateSlaHours } = await this.settings.getAll();
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTicket(tx, id, user);
      if (!UNRESOLVED.includes(t.status)) throw badRequest('工单已经解决或关闭了');
      const sub = await this.requireActiveSubscription(tx, t);
      const pending = await tx.fulfillmentTask.findFirst({
        where: { subscriptionId: sub.id, type: 'REPLACE_ACCOUNT', status: { in: OPEN_TASK } },
      });
      if (pending) {
        throw badRequest(`这个订阅已有未完成的换号任务 ${displayNo('T', pending.no)}`);
      }
      const task = await this.fulfillment.createTask(tx, {
        type: 'REPLACE_ACCOUNT',
        customerId: t.customerId,
        subscriptionId: sub.id,
        ticketId: t.id,
        dueAt: addHours(now, activateSlaHours),
        note: note?.trim() || undefined,
      });
      await recordTicketEvent(tx, {
        ticketId: id,
        kind: 'replace',
        content: `已派换号任务 ${displayNo('T', task!.no)}${note?.trim() ? `：${note.trim()}` : ''}`,
        userId: user.id,
      });
      await this.markInProgress(tx, t, user.id);
    });
    return this.get(id, user);
  }

  /** 补偿服务天数：订阅到期时间往后延 */
  async compensate(id: string, dto: CompensateDto, user: AuthUser): Promise<TicketDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      const t = await this.lockTicket(tx, id, user);
      const sub = await this.requireActiveSubscription(tx, t);
      const endAt = addDays(sub.endAt, dto.days);
      await tx.subscription.update({ where: { id: sub.id }, data: { endAt } });
      await recordTicketEvent(tx, {
        ticketId: id,
        kind: 'compensate',
        content: `补偿 ${dto.days} 天，服务期延长到 ${localDateKey(endAt)}${
          dto.note?.trim() ? `：${dto.note.trim()}` : ''
        }`,
        userId: user.id,
      });
      await this.markInProgress(tx, t, user.id);
    });
    return this.get(id, user);
  }

  /**
   * 定时巡检（和到期巡检一起跑）：
   * 超过处理时限还没解决的工单升级；已解决超过设置小时数的自动关闭。
   */
  async sweep(tx: Tx, now: Date): Promise<TicketSweepResult> {
    const { ticketAutoCloseHours } = await this.settings.getAll();
    const overdue = await tx.ticket.findMany({
      where: { status: { in: TIMED }, dueAt: { lt: now }, escalatedAt: null },
      select: {
        id: true,
        no: true,
        type: true,
        dueAt: true,
        description: true,
        assigneeId: true,
        ownerId: true,
        assignee: { select: { displayName: true } },
        customer: { select: { no: true, name: true } },
      },
    });
    for (const t of overdue) {
      await tx.ticket.update({ where: { id: t.id }, data: { escalatedAt: now } });
      await recordTicketEvent(tx, {
        ticketId: t.id,
        kind: 'escalated',
        content: `超过处理时限（${localDateTimeText(t.dueAt)}）还没解决，已升级`,
      });
      await this.notify.emit(tx, {
        event: 'ticket.escalated',
        title: `工单 ${displayNo('G', t.no)} 超时未解决，已升级`,
        body: [
          `${TICKET_TYPE_LABELS[t.type]} · 客户：${t.customer.name}（${displayNo('C', t.customer.no)}）`,
          `问题：${brief(t.description)}`,
          `处理时限：${localDateTimeText(t.dueAt)} · 负责售后：${t.assignee?.displayName ?? '没人领取'}`,
        ].join('\n'),
        link: `/tickets/${t.id}`,
        to: [t.assigneeId, t.ownerId],
        toPermission: 'ticket:handle',
      });
    }
    const stale = await tx.ticket.findMany({
      where: { status: 'RESOLVED', resolvedAt: { lte: addHours(now, -ticketAutoCloseHours) } },
      select: { id: true },
    });
    for (const t of stale) {
      await tx.ticket.update({ where: { id: t.id }, data: { status: 'CLOSED', closedAt: now } });
      await recordTicketEvent(tx, {
        ticketId: t.id,
        kind: 'closed',
        content: `已解决超过 ${ticketAutoCloseHours} 小时，自动关闭`,
      });
    }
    return { escalated: overdue.length, closed: stale.length };
  }

  private pickAssignee(tx: Tx): Promise<string | null> {
    return leastLoaded(tx, 'ticket:handle', async (ids) => {
      const rows = await tx.ticket.groupBy({
        by: ['assigneeId'],
        where: { assigneeId: { in: ids }, status: { in: UNRESOLVED } },
        _count: { _all: true },
      });
      return new Map(rows.map((r) => [r.assigneeId, r._count._all]));
    });
  }

  private async markInProgress(tx: Tx, t: Ticket, userId: string): Promise<void> {
    if (t.status !== 'OPEN') return;
    await tx.ticket.update({
      where: { id: t.id },
      data: { status: 'IN_PROGRESS', assigneeId: t.assigneeId ?? userId },
    });
  }

  private async requireActiveSubscription(tx: Tx, t: Ticket) {
    if (!t.subscriptionId) throw badRequest('工单没有关联订阅，请先确认是哪个订阅出的问题');
    const sub = await tx.subscription.findUniqueOrThrow({ where: { id: t.subscriptionId } });
    if (sub.status !== 'ACTIVE') throw badRequest('订阅已不在服务中');
    return sub;
  }

  private async lockTicket(tx: Tx, id: string, user: AuthUser): Promise<Ticket> {
    await tx.$queryRaw`SELECT id FROM "Ticket" WHERE id = ${id} FOR UPDATE`;
    const t = await tx.ticket.findFirst({ where: { id, ...visibleTickets(user) } });
    if (!t) throw notFound('工单');
    return t;
  }
}

/** 订单还能申请退款的金额 = 已收 − 已退 − 审批中 */
async function refundableOf(db: Tx | PrismaService, orderId: string): Promise<number> {
  const [order, pending] = await Promise.all([
    db.order.findUnique({
      where: { id: orderId },
      select: { paidCents: true, refundedCents: true },
    }),
    db.refund.aggregate({
      where: { orderId, status: 'PENDING' },
      _sum: { amountCents: true },
    }),
  ]);
  if (!order) return 0;
  return Math.max(0, order.paidCents - order.refundedCents - (pending._sum.amountCents ?? 0));
}

@Injectable()
export class RefundsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly fulfillment: FulfillmentService,
    private readonly commissions: CommissionEngine,
    private readonly notify: NotifyService,
    private readonly stats: CustomerStatsService,
    private readonly referrals: ReferralService,
  ) {}

  async list(q: RefundQueryDto, user: AuthUser): Promise<RefundListDto> {
    const no = parseNo(q.keyword, 'K');
    const kw = q.keyword?.trim();
    const where: Prisma.RefundWhereInput = {
      AND: [
        visibleRefunds(user),
        kw
          ? {
              OR: [
                ...(no !== undefined ? [{ no }] : []),
                { customer: { name: { contains: kw, mode: 'insensitive' } } },
              ],
            }
          : {},
      ],
      status: q.status,
      orderId: q.orderId,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.refund.findMany({
        where,
        include: refundInclude,
        orderBy: [{ createdAt: 'desc' }],
        ...skipTake(q),
      }),
      this.prisma.refund.count({ where }),
    ]);
    return { items: rows.map(toRefundDto), total };
  }

  async get(id: string, user: AuthUser): Promise<RefundDto> {
    const r = await this.prisma.refund.findFirst({
      where: { id, ...visibleRefunds(user) },
      include: refundInclude,
    });
    if (!r) throw notFound('退款');
    return toRefundDto(r);
  }

  /** 申请退款：已收款的订单（开通中 / 已完成），金额不超过还能退的部分 */
  async request(dto: CreateRefundDto, user: AuthUser): Promise<RefundDto> {
    const id = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${dto.orderId} FOR UPDATE`;
      const order = await tx.order.findFirst({
        where: { id: dto.orderId, ...visibleOrders(user) },
      });
      if (!order) throw notFound('订单');
      if (order.status !== 'FULFILLING' && order.status !== 'COMPLETED') {
        throw badRequest('只有已收款（开通中或已完成）的订单可以退款');
      }
      let ticket: Ticket | null = null;
      if (dto.ticketId) {
        ticket = await tx.ticket.findFirst({
          where: { id: dto.ticketId, ...visibleTickets(user) },
        });
        if (!ticket) throw notFound('工单');
        if (ticket.customerId !== order.customerId) throw badRequest('订单和工单不是同一个客户');
      }
      const refundable = await refundableOf(tx, order.id);
      if (dto.amountCents > refundable) {
        throw badRequest(`这笔订单最多还能退 ${formatCents(refundable)}（已扣除已退和审批中的）`);
      }
      const refund = await tx.refund.create({
        data: {
          orderId: order.id,
          customerId: order.customerId,
          subscriptionId: order.subscriptionId,
          ticketId: ticket?.id ?? null,
          amountCents: dto.amountCents,
          reason: dto.reason.trim(),
          terminate: !!dto.terminate,
          requestedById: user.id,
          ownerId: order.ownerId,
          teamId: order.teamId,
        },
      });
      const customer = await tx.customer.findUniqueOrThrow({
        where: { id: order.customerId },
        select: { no: true, name: true },
      });
      await this.notify.emit(tx, {
        event: 'refund.requested',
        title: `退款待审批 ${displayNo('K', refund.no)} · ${formatCents(dto.amountCents)}`,
        body: [
          `客户：${customer.name}（${displayNo('C', customer.no)}） · 订单 ${displayNo('D', order.no)}`,
          `原因：${brief(dto.reason.trim())}${dto.terminate ? '（退款后终止服务）' : ''}`,
          `申请人：${user.displayName}`,
        ].join('\n'),
        link: '/refunds',
        toPermission: 'refund:approve',
        except: user.id,
      });
      if (ticket) {
        await recordTicketEvent(tx, {
          ticketId: ticket.id,
          kind: 'refund',
          content: `申请退款 ${formatCents(dto.amountCents)}（${displayNo('K', refund.no)}${
            dto.terminate ? '，退款后终止服务' : ''
          }）：${dto.reason.trim()}`,
          userId: user.id,
        });
        if (ticket.status === 'OPEN') {
          await tx.ticket.update({
            where: { id: ticket.id },
            data: { status: 'IN_PROGRESS', assigneeId: ticket.assigneeId ?? user.id },
          });
        }
      }
      return refund.id;
    });
    return this.get(id, user);
  }

  /** 审批通过并登记出账；选了终止服务的同时取消开通 / 取消自动续订 / 回收成品号 */
  async approve(id: string, dto: ApproveRefundDto, user: AuthUser): Promise<RefundDto> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const refund = await this.lockPending(tx, id, user);
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${refund.orderId} FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({ where: { id: refund.orderId } });
      if (refund.amountCents > order.paidCents - order.refundedCents) {
        throw badRequest('退款金额超过订单已收减已退，不能通过');
      }
      await tx.order.update({
        where: { id: order.id },
        data: { refundedCents: { increment: refund.amountCents } },
      });
      await tx.refund.update({
        where: { id },
        data: {
          status: 'PAID',
          approvedById: user.id,
          method: dto.method,
          reference: dto.reference?.trim() || null,
          paidAt: dto.paidAt ? new Date(dto.paidAt) : now,
        },
      });
      const code = displayNo('K', refund.no);
      let terminated = '';
      if (refund.terminate) terminated = await this.terminate(tx, order, code, now);
      await this.notify.emit(tx, {
        event: 'refund.decided',
        title: `退款 ${code} 已通过并出账 · ${formatCents(refund.amountCents)}`,
        body: `订单 ${displayNo('D', order.no)} · ${methodLabel(dto.method)} · 审批人：${user.displayName}${
          terminated ? `\n${terminated}` : ''
        }`,
        link: `/orders/${order.id}`,
        to: [refund.requestedById],
        except: user.id,
      });
      // 代理佣金按退款占比扣减：冻结中 / 可结算的直接扣，已发放的记扣回
      await this.commissions.reduceForRefund(tx, order.id, id, now);
      await this.referrals.onOrderRefunded(tx, order.id);
      await this.stats.refresh(tx, [order.customerId]);
      if (refund.ticketId) {
        await recordTicketEvent(tx, {
          ticketId: refund.ticketId,
          kind: 'refund',
          content: `退款 ${formatCents(refund.amountCents)} 已出账（${code}，${methodLabel(
            dto.method,
          )}）${terminated ? `；${terminated}` : ''}`,
          userId: user.id,
        });
        const otherPending = await tx.refund.count({
          where: { ticketId: refund.ticketId, status: 'PENDING' },
        });
        if (otherPending === 0) {
          await resolveTicketBySystem(
            tx,
            refund.ticketId,
            `已退款 ${formatCents(refund.amountCents)}`,
            user.id,
            now,
          );
        }
      }
    });
    return this.get(id, user);
  }

  async reject(id: string, reason: string, user: AuthUser): Promise<RefundDto> {
    await this.prisma.$transaction(async (tx) => {
      const refund = await this.lockPending(tx, id, user);
      await tx.refund.update({
        where: { id },
        data: { status: 'REJECTED', approvedById: user.id, rejectReason: reason.trim() },
      });
      await this.notify.emit(tx, {
        event: 'refund.decided',
        title: `退款 ${displayNo('K', refund.no)} 被驳回 · ${formatCents(refund.amountCents)}`,
        body: `原因：${brief(reason.trim())}\n审批人：${user.displayName}`,
        link: `/orders/${refund.orderId}`,
        to: [refund.requestedById],
        except: user.id,
      });
      if (refund.ticketId) {
        await recordTicketEvent(tx, {
          ticketId: refund.ticketId,
          kind: 'refund',
          content: `退款 ${displayNo('K', refund.no)} 被驳回：${reason.trim()}`,
          userId: user.id,
        });
      }
    });
    return this.get(id, user);
  }

  /**
   * 退款后终止服务：
   * - 还没开通（开通中）：取消开通 / 续费任务，订单标记已取消
   * - 已开通：订阅终止，未完成的内部续费、换号任务作废；成品号建回收任务，代充建取消自动续订任务
   * 返回写进时间线的说明
   */
  private async terminate(tx: Tx, order: Order, code: string, now: Date): Promise<string> {
    const note = `已退款（${code}），服务终止`;
    if (order.status === 'FULFILLING') {
      await tx.fulfillmentTask.updateMany({
        where: { orderId: order.id, status: { in: OPEN_TASK } },
        data: { status: 'CANCELLED', note, finishedAt: now },
      });
      await tx.order.update({
        where: { id: order.id },
        data: { status: 'CANCELLED', cancelledAt: now, cancelReason: note },
      });
      return '订单还没开通，已取消开通';
    }
    if (!order.subscriptionId) return '';
    const sub = await tx.subscription.findUnique({ where: { id: order.subscriptionId } });
    if (!sub || sub.status === 'CANCELLED') return '';
    await tx.fulfillmentTask.updateMany({
      where: {
        subscriptionId: sub.id,
        type: { in: ['INTERNAL_RENEW', 'REPLACE_ACCOUNT'] },
        status: { in: OPEN_TASK },
      },
      data: { status: 'CANCELLED', note, finishedAt: now },
    });
    await tx.subscription.update({
      where: { id: sub.id },
      data: {
        status: 'CANCELLED',
        endAt: sub.endAt.getTime() > now.getTime() ? now : sub.endAt,
      },
    });
    const type = sub.fulfillmentType === 'ACCOUNT' ? 'RECLAIM_ACCOUNT' : 'CANCEL_AUTO_RENEW';
    if (type === 'CANCEL_AUTO_RENEW' && !sub.autoRenewOn) return '订阅已终止';
    const exists = await tx.fulfillmentTask.findFirst({
      where: { subscriptionId: sub.id, type, status: { in: OPEN_TASK } },
      select: { id: true },
    });
    if (!exists) {
      const { activateSlaHours } = await this.settings.getAll();
      await this.fulfillment.createTask(tx, {
        type,
        customerId: sub.customerId,
        subscriptionId: sub.id,
        dueAt: addHours(now, activateSlaHours),
        note,
      });
    }
    return type === 'RECLAIM_ACCOUNT'
      ? '订阅已终止，已派回收成品号任务'
      : '订阅已终止，已派取消自动续订任务';
  }

  private async lockPending(tx: Tx, id: string, user: AuthUser) {
    await tx.$queryRaw`SELECT id FROM "Refund" WHERE id = ${id} FOR UPDATE`;
    const refund = await tx.refund.findFirst({ where: { id, ...visibleRefunds(user) } });
    if (!refund) throw notFound('退款');
    if (refund.status !== 'PENDING') throw badRequest('这笔退款已经处理过了');
    return refund;
  }
}

// ─────────────── Controller ───────────────

@ApiTags('售后工单')
@ApiBearerAuth()
@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketsService) {}

  @Get()
  @RequireAnyPermission('ticket:create', 'ticket:handle')
  @ApiOperation({ summary: '工单列表（按数据范围）' })
  @ApiOkResponse({ type: TicketListDto })
  list(@Query() q: TicketQueryDto, @CurrentUser() user: AuthUser): Promise<TicketListDto> {
    return this.tickets.list(q, user);
  }

  @Get(':id')
  @RequireAnyPermission('ticket:create', 'ticket:handle')
  @ApiOperation({ summary: '工单详情（含质保判断、时间线、退款、换号任务）' })
  @ApiOkResponse({ type: TicketDetailDto })
  get(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<TicketDetailDto> {
    return this.tickets.get(id, user);
  }

  @Post()
  @RequireAnyPermission('ticket:create', 'ticket:handle')
  @Audit('ticket.create', '登记售后工单')
  @ApiOperation({ summary: '登记售后工单（自动派给售后）' })
  @ApiOkResponse({ type: TicketDetailDto })
  create(@Body() dto: CreateTicketDto, @CurrentUser() user: AuthUser): Promise<TicketDetailDto> {
    return this.tickets.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('ticket:handle')
  @Audit('ticket.update', '修改工单状态 / 处理人 / 客户原因')
  @ApiOperation({ summary: '修改工单状态、处理人或客户原因' })
  @ApiOkResponse({ type: TicketDetailDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateTicketDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TicketDetailDto> {
    return this.tickets.update(id, dto, user);
  }

  @Post(':id/comments')
  @HttpCode(200)
  @RequireAnyPermission('ticket:create', 'ticket:handle')
  @Audit('ticket.comment', '工单备注')
  @ApiOperation({ summary: '添加备注（沟通记录）' })
  @ApiOkResponse({ type: TicketDetailDto })
  comment(
    @Param('id') id: string,
    @Body() dto: TicketCommentDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TicketDetailDto> {
    return this.tickets.comment(id, dto.content, user);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @RequirePermissions('ticket:handle')
  @Audit('ticket.resolve', '工单标记已解决')
  @ApiOperation({ summary: '标记已解决（超过设置的小时数自动关闭）' })
  @ApiOkResponse({ type: TicketDetailDto })
  resolve(
    @Param('id') id: string,
    @Body() dto: ResolveTicketDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TicketDetailDto> {
    return this.tickets.resolve(id, dto.resolution, user);
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermissions('ticket:handle')
  @Audit('ticket.close', '关闭工单')
  @ApiOperation({ summary: '关闭工单' })
  @ApiOkResponse({ type: TicketDetailDto })
  close(
    @Param('id') id: string,
    @Body() dto: TicketReasonDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TicketDetailDto> {
    return this.tickets.close(id, dto.note, user);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RequireAnyPermission('ticket:create', 'ticket:handle')
  @Audit('ticket.reopen', '重新打开工单')
  @ApiOperation({ summary: '重新打开（客户反馈问题没解决）' })
  @ApiOkResponse({ type: TicketDetailDto })
  reopen(
    @Param('id') id: string,
    @Body() dto: ReopenTicketDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TicketDetailDto> {
    return this.tickets.reopen(id, dto.reason, user);
  }

  @Post(':id/replace')
  @HttpCode(200)
  @RequirePermissions('ticket:handle')
  @Audit('ticket.replace', '派换号任务')
  @ApiOperation({ summary: '派换号任务给充值员（服务期不变）' })
  @ApiOkResponse({ type: TicketDetailDto })
  replace(
    @Param('id') id: string,
    @Body() dto: TicketReasonDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TicketDetailDto> {
    return this.tickets.replace(id, dto.note, user);
  }

  @Post(':id/compensate')
  @HttpCode(200)
  @RequirePermissions('ticket:handle')
  @Audit('ticket.compensate', '补偿服务天数')
  @ApiOperation({ summary: '补偿服务天数（订阅到期时间往后延）' })
  @ApiOkResponse({ type: TicketDetailDto })
  compensate(
    @Param('id') id: string,
    @Body() dto: CompensateDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TicketDetailDto> {
    return this.tickets.compensate(id, dto, user);
  }
}

@ApiTags('售后工单')
@ApiBearerAuth()
@Controller('refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get()
  @RequireAnyPermission('refund:approve', 'ticket:handle', 'finance:read')
  @ApiOperation({ summary: '退款列表（按数据范围）' })
  @ApiOkResponse({ type: RefundListDto })
  list(@Query() q: RefundQueryDto, @CurrentUser() user: AuthUser): Promise<RefundListDto> {
    return this.refunds.list(q, user);
  }

  @Post()
  @RequirePermissions('ticket:handle')
  @Audit('refund.request', '申请退款')
  @ApiOperation({ summary: '申请退款（等财务审批）' })
  @ApiOkResponse({ type: RefundDto })
  request(@Body() dto: CreateRefundDto, @CurrentUser() user: AuthUser): Promise<RefundDto> {
    return this.refunds.request(dto, user);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermissions('refund:approve')
  @Audit('refund.approve', '审批退款并出账')
  @ApiOperation({ summary: '审批通过并登记出账（选了终止服务的同时派对应任务）' })
  @ApiOkResponse({ type: RefundDto })
  approve(
    @Param('id') id: string,
    @Body() dto: ApproveRefundDto,
    @CurrentUser() user: AuthUser,
  ): Promise<RefundDto> {
    return this.refunds.approve(id, dto, user);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermissions('refund:approve')
  @Audit('refund.reject', '驳回退款')
  @ApiOperation({ summary: '驳回退款' })
  @ApiOkResponse({ type: RefundDto })
  reject(
    @Param('id') id: string,
    @Body() dto: RejectRefundDto,
    @CurrentUser() user: AuthUser,
  ): Promise<RefundDto> {
    return this.refunds.reject(id, dto.reason, user);
  }
}

@Module({
  imports: [SettingsModule, FulfillmentModule, LedgerModule],
  providers: [TicketsService, RefundsService],
  controllers: [TicketsController, RefundsController],
  exports: [TicketsService],
})
export class AftersalesModule {}
