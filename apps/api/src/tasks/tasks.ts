import {
  Body,
  Controller,
  ForbiddenException,
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
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Prisma, type FulfillmentTask } from '@prisma/client';
import {
  ALL_PERMISSIONS,
  FULFILLMENT_TYPES,
  SUBSCRIPTION_STATUSES,
  TASK_STATUSES,
  TASK_TYPES,
  TASK_TYPE_LABELS,
  displayNo,
  parseNo,
  type FulfillmentType,
  type OrderKind,
  type OrderStatus,
  type SubscriptionStatus,
  type TaskStatus,
  type TaskType,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { Audit, CurrentUser, RequirePermissions } from '../auth/decorators';
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
import { addMonths } from '../common/dates';
import { recordTicketEvent, resolveTicketBySystem } from '../aftersales/ticket-events';
import { badRequest, notFound } from '../common/errors';
import { PageQueryDto, skipTake } from '../common/pagination';
import { SecretBox } from '../common/secret-box';
import { productName } from '../catalog/catalog';
import { toCustomerBrief } from '../orders/orders';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { FulfillmentService, type Tx } from '../fulfillment/fulfillment.service';
import { LedgerModule, LedgerService } from '../inventory/ledger';

const OPEN: TaskStatus[] = ['PENDING', 'IN_PROGRESS', 'FAILED'];
/**
 * 可以手动作废的系统任务：客户明确会续费时可以不取消自动续订、暂不回收成品号。
 * 开通 / 续费跟着订单走；内部续费关系到上游扣费，都不能作废，处理不了就标记失败。
 */
const CANCELLABLE: TaskType[] = ['CANCEL_AUTO_RENEW', 'RECLAIM_ACCOUNT'];

/**
 * 完成任务时要不要登记上游扣费：
 * required 必须登记（代充开通、客户续费、内部续费都会花钱）；
 * optional 可选（成品号开通一般用库存里已付费的号，号过期了才要重新付）；
 * none 不涉及扣费。
 */
export type ChargeMode = 'required' | 'optional' | 'none';
export function chargeModeOf(type: TaskType, fulfillmentType: FulfillmentType): ChargeMode {
  if (type === 'ACTIVATE' || type === 'REPLACE_ACCOUNT') {
    return fulfillmentType === 'ACCOUNT' ? 'optional' : 'required';
  }
  if (type === 'RENEW' || type === 'INTERNAL_RENEW') return 'required';
  return 'none';
}

// ─────────────── DTO ───────────────

const toBool = ({ value }: { value: unknown }) => value === true || value === 'true';

export class TaskQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: ['open', 'closed', 'all'],
    default: 'open',
    description: 'open 未完成（待处理 / 处理中 / 失败）；closed 已完成或已取消',
  })
  @IsOptional()
  @IsIn(['open', 'closed', 'all'])
  view?: 'open' | 'closed' | 'all';

  @ApiPropertyOptional({ enum: TASK_STATUSES, enumName: 'TaskStatus' })
  @IsOptional()
  @IsIn(TASK_STATUSES)
  status?: TaskStatus;

  @ApiPropertyOptional({ enum: TASK_TYPES, enumName: 'TaskType' })
  @IsOptional()
  @IsIn(TASK_TYPES)
  type?: TaskType;

  @ApiPropertyOptional({ description: 'me 我的；unassigned 任务池（未分配）；或员工 ID' })
  @IsOptional()
  @IsString()
  assignee?: string;

  @ApiPropertyOptional({ description: '只看已超时的' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  overdue?: boolean;

  @ApiPropertyOptional({ description: '任务编号、客户称呼或账号邮箱' })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subscriptionId?: string;
}

export class CompleteTaskDto {
  @ApiPropertyOptional({ description: '处理结果备注' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ description: '新开通：实际开通时间（服务期从这里开始算），默认现在' })
  @IsOptional()
  @IsDateString()
  activatedAt?: string;

  @ApiPropertyOptional({
    description:
      '上游（官方）下次扣费时间。不填时：开通 = 开通时间 + 1 个月；内部续费 = 原扣费时间 + 1 个月',
  })
  @IsOptional()
  @IsDateString()
  upstreamRenewAt?: string;

  @ApiPropertyOptional({
    description: '成品号开通 / 换号：交付给客户的账号邮箱；代充换号：客户新的 Claude 账号邮箱',
  })
  @IsOptional()
  @IsEmail({}, { message: '账号邮箱格式不正确' })
  accountEmail?: string;

  @ApiPropertyOptional({ description: '成品号开通 / 回收后改密：账号密码（加密保存）' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  accountPassword?: string;

  @ApiPropertyOptional({ description: '成品号：恢复邮箱、备用码等其他敏感信息（加密保存）' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  accountSecretNote?: string;

  @ApiPropertyOptional({
    description: '成品号开通 / 换号：从库存里选的成品号 ID（和 accountEmail 二选一）',
  })
  @IsOptional()
  @IsString()
  stockAccountId?: string;

  @ApiPropertyOptional({ description: '这次上游扣费用的付款资源' })
  @IsOptional()
  @IsString()
  resourceId?: string;

  @ApiPropertyOptional({ description: '上游扣费金额（美分，不含手续费），默认是套餐官方月费' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000_00)
  chargeUsdCents?: number;

  @ApiPropertyOptional({ description: '这次没有产生上游扣费（例如账号本来就在付费期内）' })
  @IsOptional()
  @IsBoolean()
  noCharge?: boolean;

  @ApiPropertyOptional({
    enum: ['STOCK', 'VOID'],
    description:
      '回收成品号 / 成品号换号时旧号的去向：STOCK 回库继续卖；VOID 作废。回收默认回库，换号默认作废',
  })
  @IsOptional()
  @IsIn(['STOCK', 'VOID'])
  reclaimTo?: 'STOCK' | 'VOID';
}

export class TaskNoteDto {
  @ApiProperty({ example: '客户账号被风控，等客户换号' })
  @IsString()
  @IsNotEmpty({ message: '请填写原因' })
  @MaxLength(500)
  note: string;
}

export class AssignTaskDto {
  @ApiPropertyOptional({ type: String, nullable: true, description: '不填或 null = 放回任务池' })
  @IsOptional()
  @IsString()
  assigneeId?: string | null;
}

export class TaskOrderDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty({ enum: ['NEW', 'RENEWAL'], enumName: 'OrderKind' }) kind: OrderKind;
  @ApiProperty({
    enum: ['PENDING_PAYMENT', 'FULFILLING', 'COMPLETED', 'CANCELLED'],
    enumName: 'OrderStatus',
  })
  status: OrderStatus;
  @ApiProperty() productName: string;
  @ApiProperty() termMonths: number;
}

export class TaskSubscriptionDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty() planName: string;
  @ApiProperty({ enum: SUBSCRIPTION_STATUSES, enumName: 'SubscriptionStatus' })
  status: SubscriptionStatus;
  @ApiProperty() startAt: Date;
  @ApiProperty() endAt: Date;
  @ApiProperty({ type: String, nullable: true }) upstreamRenewAt: Date | null;
  @ApiProperty() autoRenewOn: boolean;
}

export class TaskTicketDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'G00003' }) code: string;
  @ApiProperty({ description: '工单问题描述' }) description: string;
}

export class TaskDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'T00012' }) code: string;
  @ApiProperty({ enum: TASK_TYPES, enumName: 'TaskType' }) type: TaskType;
  @ApiProperty({ enum: TASK_STATUSES, enumName: 'TaskStatus' }) status: TaskStatus;
  @ApiProperty({ enum: FULFILLMENT_TYPES, enumName: 'FulfillmentType' })
  fulfillmentType: FulfillmentType;
  @ApiProperty({ type: CustomerBriefDto }) customer: CustomerBriefDto;
  @ApiProperty({ type: TaskOrderDto, nullable: true }) order: TaskOrderDto | null;
  @ApiProperty({ type: TaskSubscriptionDto, nullable: true })
  subscription: TaskSubscriptionDto | null;
  @ApiProperty({ type: AccountBriefDto, nullable: true, description: '要操作的 Claude 账号' })
  account: AccountBriefDto | null;
  @ApiProperty({ type: TaskTicketDto, nullable: true, description: '售后换号任务对应的工单' })
  ticket: TaskTicketDto | null;
  @ApiProperty({ type: UserBriefDto, nullable: true }) assignee: UserBriefDto | null;
  @ApiProperty({ type: String, nullable: true, description: '涉及的套餐（成品号开通按它选库存）' })
  planId: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: '套餐官方月费（美分），扣费金额的默认值',
  })
  upstreamMonthlyUsdCents: number | null;
  @ApiProperty({
    enum: ['required', 'optional', 'none'],
    description: '完成时是否要登记上游扣费',
  })
  chargeMode: ChargeMode;
  @ApiProperty() dueAt: Date;
  @ApiProperty({ description: '未完成且已过最晚完成时间' }) overdue: boolean;
  @ApiProperty() attempts: number;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty({ type: String, nullable: true }) startedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) finishedAt: Date | null;
  @ApiProperty() createdAt: Date;
}

export class TaskListDto {
  @ApiProperty({ type: [TaskDto] }) items: TaskDto[];
  @ApiProperty() total: number;
}

// ─────────────── Service ───────────────

const subscriptionSelect = {
  id: true,
  no: true,
  status: true,
  fulfillmentType: true,
  startAt: true,
  endAt: true,
  upstreamRenewAt: true,
  autoRenewOn: true,
  plan: { select: { id: true, name: true, upstreamMonthlyUsdCents: true } },
  account: { select: accountBriefSelect },
} satisfies Prisma.SubscriptionSelect;

const taskInclude = {
  customer: { select: customerBriefSelect },
  assignee: { select: userBriefSelect },
  order: {
    select: {
      id: true,
      no: true,
      kind: true,
      status: true,
      planName: true,
      termMonths: true,
      fulfillmentType: true,
      account: { select: accountBriefSelect },
      product: { select: { plan: { select: { id: true, upstreamMonthlyUsdCents: true } } } },
    },
  },
  subscription: { select: subscriptionSelect },
  ticket: { select: { id: true, no: true, description: true } },
} satisfies Prisma.FulfillmentTaskInclude;
type TaskRow = Prisma.FulfillmentTaskGetPayload<{ include: typeof taskInclude }>;

function toTaskDto(t: TaskRow, now = new Date()): TaskDto {
  const sub = t.subscription;
  const account = sub?.account ?? t.order?.account ?? null;
  const fulfillmentType = (sub?.fulfillmentType ??
    t.order?.fulfillmentType ??
    'RECHARGE') as FulfillmentType;
  // 新开通 / 续费按订单买的套餐（续费可能换套餐），其他任务按订阅当前套餐
  const plan = t.order?.product.plan ?? sub?.plan ?? null;
  return {
    id: t.id,
    code: displayNo('T', t.no),
    type: t.type,
    status: t.status,
    fulfillmentType,
    customer: toCustomerBrief(t.customer),
    order: t.order
      ? {
          id: t.order.id,
          code: displayNo('D', t.order.no),
          kind: t.order.kind,
          status: t.order.status,
          productName: productName(t.order.planName, t.order.termMonths, t.order.fulfillmentType),
          termMonths: t.order.termMonths,
        }
      : null,
    subscription: sub
      ? {
          id: sub.id,
          code: displayNo('S', sub.no),
          planName: sub.plan.name,
          status: sub.status,
          startAt: sub.startAt,
          endAt: sub.endAt,
          upstreamRenewAt: sub.upstreamRenewAt,
          autoRenewOn: sub.autoRenewOn,
        }
      : null,
    account: account ? toAccountBrief(account) : null,
    ticket: t.ticket
      ? { id: t.ticket.id, code: displayNo('G', t.ticket.no), description: t.ticket.description }
      : null,
    assignee: t.assignee,
    planId: plan?.id ?? null,
    upstreamMonthlyUsdCents: plan?.upstreamMonthlyUsdCents ?? null,
    chargeMode: chargeModeOf(t.type, fulfillmentType),
    dueAt: t.dueAt,
    overdue: OPEN.includes(t.status) && t.dueAt.getTime() < now.getTime(),
    attempts: t.attempts,
    note: t.note,
    startedAt: t.startedAt,
    finishedAt: t.finishedAt,
    createdAt: t.createdAt,
  };
}

const optionalDate = (v?: string) => (v ? new Date(v) : undefined);

/** 完成任务时这次上游扣费要归到哪 */
interface ChargeTarget {
  mode: ChargeMode;
  orderId: string | null;
  subscriptionId: string;
  accountId: string;
  planId: string;
}

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfillment: FulfillmentService,
    private readonly secrets: SecretBox,
    private readonly ledger: LedgerService,
  ) {}

  async list(q: TaskQueryDto, user: AuthUser): Promise<TaskListDto> {
    const now = new Date();
    const view = q.view ?? 'open';
    const no = parseNo(q.keyword, 'T');
    const kw = q.keyword?.trim();
    const statusFilter: Prisma.FulfillmentTaskWhereInput['status'] = q.status
      ? q.status
      : view === 'open'
        ? { in: OPEN }
        : view === 'closed'
          ? { in: ['DONE', 'CANCELLED'] }
          : undefined;
    const where: Prisma.FulfillmentTaskWhereInput = {
      status: statusFilter,
      type: q.type,
      subscriptionId: q.subscriptionId,
      assigneeId:
        q.assignee === 'me'
          ? user.id
          : q.assignee === 'unassigned'
            ? null
            : q.assignee || undefined,
      ...(q.overdue ? { dueAt: { lt: now }, status: { in: OPEN } } : {}),
      OR: kw
        ? [
            ...(no !== undefined ? [{ no }] : []),
            { customer: { name: { contains: kw, mode: 'insensitive' } } },
            { order: { accountEmail: { contains: kw, mode: 'insensitive' } } },
            { subscription: { account: { email: { contains: kw, mode: 'insensitive' } } } },
          ]
        : undefined,
    };
    const orderBy: Prisma.FulfillmentTaskOrderByWithRelationInput[] =
      view === 'open' ? [{ dueAt: 'asc' }, { no: 'asc' }] : [{ updatedAt: 'desc' }];
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.fulfillmentTask.findMany({
        where,
        include: taskInclude,
        orderBy,
        ...skipTake(q),
      }),
      this.prisma.fulfillmentTask.count({ where }),
    ]);
    return { items: rows.map((r) => toTaskDto(r, now)), total };
  }

  async get(id: string): Promise<TaskDto> {
    const t = await this.prisma.fulfillmentTask.findUnique({ where: { id }, include: taskInclude });
    if (!t) throw notFound('任务');
    return toTaskDto(t);
  }

  /** 领取 / 开始处理 */
  async claim(id: string, user: AuthUser): Promise<TaskDto> {
    await this.prisma.$transaction(async (tx) => {
      const task = await this.lockOpenTask(tx, id, user);
      await tx.fulfillmentTask.update({
        where: { id },
        data: {
          status: 'IN_PROGRESS',
          assigneeId: user.id,
          startedAt: task.startedAt ?? new Date(),
        },
      });
    });
    return this.get(id);
  }

  /** 转交给其他充值员，或放回任务池 */
  async assign(id: string, assigneeId: string | null, user: AuthUser): Promise<TaskDto> {
    if (assigneeId) {
      const target = await this.prisma.user.findFirst({
        where: { id: assigneeId, deletedAt: null, status: 'ACTIVE' },
        include: { roles: { include: { role: { select: { permissions: true } } } } },
      });
      const perms = target?.roles.flatMap((r) => r.role.permissions) ?? [];
      if (!target || !(perms.includes('fulfillment:handle') || perms.includes(ALL_PERMISSIONS))) {
        throw badRequest('只能转交给有「处理开通任务」权限的在职员工');
      }
    }
    await this.prisma.$transaction(async (tx) => {
      await this.lockOpenTask(tx, id, user, { allowOthersInProgress: true });
      await tx.fulfillmentTask.update({
        where: { id },
        // 换人之后由新负责人重新开始处理
        data: { assigneeId: assigneeId ?? null, status: 'PENDING', startedAt: null },
      });
    });
    return this.get(id);
  }

  async fail(id: string, note: string, user: AuthUser): Promise<TaskDto> {
    await this.prisma.$transaction(async (tx) => {
      const task = await this.lockOpenTask(tx, id, user);
      await tx.fulfillmentTask.update({
        where: { id },
        data: {
          status: 'FAILED',
          attempts: { increment: 1 },
          note: note.trim(),
          assigneeId: task.assigneeId ?? user.id,
        },
      });
      if (task.ticketId) {
        await recordTicketEvent(tx, {
          ticketId: task.ticketId,
          kind: 'replace',
          content: `换号任务 ${displayNo('T', task.no)} 处理失败：${note.trim()}`,
          userId: user.id,
        });
      }
    });
    return this.get(id);
  }

  /** 作废「取消自动续订 / 回收成品号」任务（例如客户确认马上续费） */
  async cancel(id: string, note: string, user: AuthUser): Promise<TaskDto> {
    await this.prisma.$transaction(async (tx) => {
      const task = await this.lockOpenTask(tx, id, user, { allowOthersInProgress: true });
      if (!CANCELLABLE.includes(task.type)) {
        throw badRequest(
          '只有「取消自动续订」和「回收成品号」任务可以作废；处理不了请标记失败并写明原因',
        );
      }
      await tx.fulfillmentTask.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          note: note.trim(),
          finishedAt: new Date(),
          assigneeId: task.assigneeId ?? user.id,
        },
      });
    });
    return this.get(id);
  }

  /** 完成任务，并按任务类型更新订阅、账号和订单；花了钱的任务同时登记上游扣费和成本 */
  async complete(id: string, dto: CompleteTaskDto, user: AuthUser): Promise<TaskDto> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const task = await this.lockOpenTask(tx, id, user);
      let subscriptionId = task.subscriptionId;
      let charge: ChargeTarget | null = null;
      switch (task.type) {
        case 'ACTIVATE': {
          const r = await this.completeActivate(tx, task.orderId, dto, now, user.id);
          subscriptionId = r.subscriptionId;
          charge = r.charge;
          break;
        }
        case 'RENEW':
          charge = await this.completeRenew(tx, task.orderId, task.subscriptionId, dto, now);
          break;
        case 'INTERNAL_RENEW': {
          const sub = await this.requireSubscription(tx, task.subscriptionId);
          const chargeAt = sub.upstreamRenewAt ?? now;
          await tx.subscription.update({
            where: { id: sub.id },
            data: {
              upstreamRenewAt: optionalDate(dto.upstreamRenewAt) ?? addMonths(chargeAt, 1),
            },
          });
          // 这次扣费的成本归到服务期覆盖扣费日的那笔订单
          charge = {
            mode: 'required',
            orderId: await this.ledger.orderForPeriod(tx, sub.id, chargeAt),
            subscriptionId: sub.id,
            accountId: sub.accountId,
            planId: sub.planId,
          };
          break;
        }
        case 'CANCEL_AUTO_RENEW': {
          const sub = await this.requireSubscription(tx, task.subscriptionId);
          // 上游服务会用到 upstreamRenewAt 那一刻为止，保留这个时间供参考
          await tx.subscription.update({ where: { id: sub.id }, data: { autoRenewOn: false } });
          break;
        }
        case 'REPLACE_ACCOUNT':
          charge = await this.completeReplace(tx, task, dto, now, user.id);
          break;
        case 'RECLAIM_ACCOUNT': {
          const sub = await this.requireSubscription(tx, task.subscriptionId);
          if (sub.status === 'ACTIVE') {
            throw badRequest('订阅还在服务中（客户可能已经续费），不能回收');
          }
          const toStock = (dto.reclaimTo ?? 'STOCK') === 'STOCK';
          await tx.claudeAccount.update({
            where: { id: sub.accountId },
            data: {
              customerId: null,
              stockStatus: toStock ? 'IN_STOCK' : 'VOID',
              planId: sub.planId,
              // 之前的成本都已经归到客户的订单上了，回库从 0 开始算
              stockCostCents: 0,
              // 上游已经付费到这一天；之后再发给别人时按它判断要不要重新付费
              upstreamRenewAt: sub.upstreamRenewAt,
              stockedAt: now,
              ...(dto.accountPassword
                ? { passwordEnc: this.secrets.encrypt(dto.accountPassword) }
                : {}),
            },
          });
          // 自动续订是否关掉由「取消自动续订」任务决定（成品号可能留着继续卖）
          await tx.subscription.update({ where: { id: sub.id }, data: { status: 'CANCELLED' } });
          break;
        }
      }
      if (charge) await this.recordCharge(tx, task, charge, dto, user.id);
      await tx.fulfillmentTask.update({
        where: { id },
        data: {
          status: 'DONE',
          assigneeId: user.id,
          subscriptionId,
          startedAt: task.startedAt ?? now,
          finishedAt: now,
          note: dto.note?.trim() || task.note,
        },
      });
    });
    return this.get(id);
  }

  /** 登记这次任务的上游扣费：扣付款资源余额，按平均成本把人民币成本记到订单上 */
  private async recordCharge(
    tx: Tx,
    task: FulfillmentTask,
    target: ChargeTarget,
    dto: CompleteTaskDto,
    userId: string,
  ): Promise<void> {
    if (target.mode === 'none' || dto.noCharge) return;
    if (!dto.resourceId) {
      if (target.mode === 'required' && (await this.ledger.hasActiveResources(tx))) {
        throw badRequest(
          '请选择这次上游扣费用的付款资源；如果这次没有扣费，请勾选「本次未扣费」',
          'CHARGE_REQUIRED',
        );
      }
      return;
    }
    const plan = await tx.plan.findUniqueOrThrow({ where: { id: target.planId } });
    await this.ledger.chargeUpstream(tx, {
      resourceId: dto.resourceId,
      usdCents: dto.chargeUsdCents ?? plan.upstreamMonthlyUsdCents,
      orderId: target.orderId,
      subscriptionId: target.subscriptionId,
      taskId: task.id,
      accountId: target.accountId,
      note: `${TASK_TYPE_LABELS[task.type]} ${displayNo('T', task.no)}`,
      userId,
    });
  }

  // ─── 各类任务的完成逻辑 ───

  private async completeActivate(
    tx: Tx,
    orderId: string | null,
    dto: CompleteTaskDto,
    now: Date,
    userId: string,
  ): Promise<{ subscriptionId: string; charge: ChargeTarget }> {
    const order = await tx.order.findUnique({ where: { id: orderId ?? '' } });
    if (!order || order.status !== 'FULFILLING') throw badRequest('订单不在「开通中」状态');
    const [product, customer] = await Promise.all([
      tx.product.findUniqueOrThrow({ where: { id: order.productId }, include: { plan: true } }),
      tx.customer.findUniqueOrThrow({ where: { id: order.customerId } }),
    ]);

    let accountId = order.accountId;
    let stockRenewAt: Date | null = null;
    if (order.fulfillmentType === 'ACCOUNT') {
      const delivered = await this.deliverCompanyAccount(
        tx,
        { customerId: order.customerId, orderId: order.id },
        product.plan,
        dto,
        now,
        userId,
      );
      accountId = delivered.accountId;
      stockRenewAt = delivered.upstreamRenewAt;
    }
    if (!accountId) throw badRequest('订单没有登记 Claude 账号');
    const busy = await tx.subscription.findFirst({ where: { accountId, status: 'ACTIVE' } });
    if (busy) {
      throw badRequest(`这个账号已有服务中的订阅 ${displayNo('S', busy.no)}，请改走续费`);
    }

    const startAt = optionalDate(dto.activatedAt) ?? now;
    if (startAt.getTime() > now.getTime() + 60_000) throw badRequest('开通时间不能晚于现在');
    const endAt = addMonths(startAt, order.termMonths);
    const sub = await tx.subscription.create({
      data: {
        customerId: order.customerId,
        accountId,
        planId: product.planId,
        fulfillmentType: order.fulfillmentType,
        status: 'ACTIVE',
        startAt,
        endAt,
        // 成品号在库时已经付费到某天的，接着按那天算；否则从开通起一个月后扣费
        upstreamRenewAt:
          optionalDate(dto.upstreamRenewAt) ??
          (dto.resourceId ? null : stockRenewAt) ??
          addMonths(startAt, 1),
        autoRenewOn: true,
        ownerId: customer.ownerId,
        teamId: customer.teamId,
      },
      include: { account: { select: { email: true } } },
    });
    await tx.order.update({
      where: { id: order.id },
      data: {
        subscriptionId: sub.id,
        accountId,
        accountEmail: sub.account.email,
        status: 'COMPLETED',
        completedAt: now,
        periodStartAt: startAt,
        periodEndAt: endAt,
      },
    });
    return {
      subscriptionId: sub.id,
      charge: {
        mode: chargeModeOf('ACTIVATE', order.fulfillmentType),
        orderId: order.id,
        subscriptionId: sub.id,
        accountId,
        planId: product.planId,
      },
    };
  }

  private async completeRenew(
    tx: Tx,
    orderId: string | null,
    subscriptionId: string | null,
    dto: CompleteTaskDto,
    now: Date,
  ): Promise<ChargeTarget> {
    const order = await tx.order.findUnique({ where: { id: orderId ?? '' } });
    if (!order || order.status !== 'FULFILLING') throw badRequest('订单不在「开通中」状态');
    const sub = await this.requireSubscription(tx, subscriptionId);
    if (sub.status === 'CANCELLED') {
      throw badRequest('这个订阅已终止（成品号已回收），无法续费；请和客户确认改为新购或退款');
    }
    const product = await tx.product.findUniqueOrThrow({ where: { id: order.productId } });
    await this.fulfillment.applyRenewal(
      tx,
      order,
      sub,
      product.planId,
      { upstreamRenewAt: optionalDate(dto.upstreamRenewAt) },
      now,
    );
    return {
      mode: 'required',
      orderId: order.id,
      subscriptionId: sub.id,
      accountId: sub.accountId,
      planId: product.planId,
    };
  }

  /**
   * 售后换号：给客户换一个账号，服务期不变。
   * 成品号从库存选新号（旧号默认作废）；代充换成客户提供的新账号，一般要重新付费。
   * 成本归到服务期覆盖现在的那笔订单；完成后关联的工单自动标记已解决。
   */
  private async completeReplace(
    tx: Tx,
    task: FulfillmentTask,
    dto: CompleteTaskDto,
    now: Date,
    userId: string,
  ): Promise<ChargeTarget> {
    const sub = await this.requireSubscription(tx, task.subscriptionId);
    if (sub.status !== 'ACTIVE') throw badRequest('订阅已不在服务中，不能换号');
    const [plan, old] = await Promise.all([
      tx.plan.findUniqueOrThrow({ where: { id: sub.planId } }),
      tx.claudeAccount.findUniqueOrThrow({ where: { id: sub.accountId } }),
    ]);
    const orderId = await this.ledger.orderForPeriod(tx, sub.id, now);

    let accountId: string;
    let paidThrough: Date | null = null;
    if (sub.fulfillmentType === 'ACCOUNT') {
      if (dto.accountEmail?.trim().toLowerCase() === old.email || dto.stockAccountId === old.id) {
        throw badRequest('新账号和原账号是同一个');
      }
      const delivered = await this.deliverCompanyAccount(
        tx,
        { customerId: sub.customerId, orderId },
        plan,
        dto,
        now,
        userId,
      );
      accountId = delivered.accountId;
      paidThrough = delivered.upstreamRenewAt;
    } else {
      if (!dto.accountEmail) throw badRequest('代充换号要填写客户新的 Claude 账号邮箱');
      accountId = await this.replacementCustomerAccount(tx, sub.customerId, old.id, dto);
    }
    const busy = await tx.subscription.findFirst({
      where: { accountId, status: 'ACTIVE', id: { not: sub.id } },
    });
    if (busy) throw badRequest(`新账号已有服务中的订阅 ${displayNo('S', busy.no)}`);

    if (sub.fulfillmentType === 'ACCOUNT') {
      const toStock = dto.reclaimTo === 'STOCK';
      await tx.claudeAccount.update({
        where: { id: old.id },
        data: {
          customerId: null,
          stockStatus: toStock ? 'IN_STOCK' : 'VOID',
          planId: sub.planId,
          stockCostCents: 0,
          upstreamRenewAt: toStock ? sub.upstreamRenewAt : null,
          stockedAt: now,
        },
      });
    }
    const charged = !!dto.resourceId && !dto.noCharge;
    const updated = await tx.subscription.update({
      where: { id: sub.id },
      data: {
        accountId,
        autoRenewOn: true,
        upstreamRenewAt:
          optionalDate(dto.upstreamRenewAt) ?? (charged ? null : paidThrough) ?? addMonths(now, 1),
      },
      include: { account: { select: { email: true } } },
    });
    if (task.ticketId) {
      await recordTicketEvent(tx, {
        ticketId: task.ticketId,
        kind: 'replace',
        content: `换号完成（${displayNo('T', task.no)}）：${old.email} → ${updated.account.email}`,
        userId,
      });
      await resolveTicketBySystem(tx, task.ticketId, '已换号', userId, now);
    }
    return {
      mode: chargeModeOf('REPLACE_ACCOUNT', sub.fulfillmentType),
      orderId,
      subscriptionId: sub.id,
      accountId,
      planId: sub.planId,
    };
  }

  /** 代充换号：登记客户新的 Claude 账号（同一个邮箱只能属于一个客户） */
  private async replacementCustomerAccount(
    tx: Tx,
    customerId: string,
    oldAccountId: string,
    dto: CompleteTaskDto,
  ): Promise<string> {
    const email = dto.accountEmail!.trim().toLowerCase();
    const existing = await tx.claudeAccount.findUnique({
      where: { email },
      include: { customer: { select: { no: true } } },
    });
    if (!existing) {
      const created = await tx.claudeAccount.create({
        data: {
          email,
          ownership: 'CUSTOMER',
          customerId,
          passwordEnc: this.secrets.encryptOptional(dto.accountPassword),
          ...(dto.accountSecretNote
            ? { secretNoteEnc: this.secrets.encrypt(dto.accountSecretNote) }
            : {}),
        },
      });
      return created.id;
    }
    if (existing.id === oldAccountId) throw badRequest('新账号和原账号是同一个');
    if (existing.ownership === 'COMPANY') {
      throw badRequest('这个邮箱是公司的成品号，代充换号要填客户自己的账号');
    }
    if (existing.customerId && existing.customerId !== customerId) {
      throw badRequest(`这个账号已登记在客户 ${displayNo('C', existing.customer!.no)} 名下`);
    }
    await tx.claudeAccount.update({
      where: { id: existing.id },
      data: {
        customerId,
        ...(dto.accountPassword ? { passwordEnc: this.secrets.encrypt(dto.accountPassword) } : {}),
      },
    });
    return existing.id;
  }

  /**
   * 成品号开通 / 换号：从库存选号（或登记一个新号）交付给客户。
   * 在库期间累计的备号成本在这里结转到订单。
   */
  private async deliverCompanyAccount(
    tx: Tx,
    target: { customerId: string; orderId: string | null },
    plan: { id: string; name: string },
    dto: CompleteTaskDto,
    now: Date,
    userId: string,
  ): Promise<{ accountId: string; upstreamRenewAt: Date | null }> {
    const secretNoteEnc = dto.accountSecretNote
      ? { secretNoteEnc: this.secrets.encrypt(dto.accountSecretNote) }
      : {};
    let existingId: string | null = null;
    if (dto.stockAccountId) {
      existingId = dto.stockAccountId;
    } else {
      if (!dto.accountEmail) throw badRequest('成品号开通要从库存选一个号，或填写交付的账号邮箱');
      const email = dto.accountEmail.trim().toLowerCase();
      const found = await tx.claudeAccount.findUnique({ where: { email }, select: { id: true } });
      if (!found) {
        if (!dto.accountPassword) throw badRequest('新的成品号要填写登录密码');
        const created = await tx.claudeAccount.create({
          data: {
            email,
            ownership: 'COMPANY',
            customerId: target.customerId,
            stockStatus: 'IN_USE',
            planId: plan.id,
            passwordEnc: this.secrets.encrypt(dto.accountPassword),
            ...secretNoteEnc,
          },
        });
        return { accountId: created.id, upstreamRenewAt: null };
      }
      existingId = found.id;
    }

    // 锁住账号行，避免两个人同时把同一个库存号发出去
    await tx.$queryRaw`SELECT id FROM "ClaudeAccount" WHERE id = ${existingId} FOR UPDATE`;
    const existing = await tx.claudeAccount.findUnique({
      where: { id: existingId },
      include: { customer: { select: { no: true } }, plan: { select: { name: true } } },
    });
    if (!existing) throw badRequest('库存里没有这个成品号');
    if (existing.ownership !== 'COMPANY') {
      throw badRequest('这个邮箱是客户自己的账号，不能当成品号交付');
    }
    if (existing.stockStatus === 'VOID') throw badRequest('这个成品号已作废，不能再发');
    if (existing.customerId && existing.customerId !== target.customerId) {
      throw badRequest(`这个成品号正在给客户 ${displayNo('C', existing.customer!.no)} 使用`);
    }
    if (existing.planId && existing.planId !== plan.id) {
      throw badRequest(
        `这个成品号是 ${existing.plan?.name ?? '其他'} 套餐的库存，订单买的是 ${plan.name}`,
      );
    }
    await tx.claudeAccount.update({
      where: { id: existing.id },
      data: {
        customerId: target.customerId,
        stockStatus: 'IN_USE',
        planId: plan.id,
        stockCostCents: 0,
        upstreamRenewAt: null,
        ...(dto.accountPassword ? { passwordEnc: this.secrets.encrypt(dto.accountPassword) } : {}),
        ...secretNoteEnc,
      },
    });
    if (existing.stockCostCents !== 0) {
      await this.ledger.recordCost(tx, {
        kind: 'ACCOUNT_STOCK',
        amountCents: existing.stockCostCents,
        orderId: target.orderId,
        accountId: existing.id,
        note: `成品号 ${existing.email} 的备号成本`,
        userId,
      });
    }
    const paidThrough = existing.upstreamRenewAt;
    return {
      accountId: existing.id,
      upstreamRenewAt: paidThrough && paidThrough.getTime() > now.getTime() ? paidThrough : null,
    };
  }

  private async requireSubscription(tx: Tx, id: string | null) {
    const sub = await tx.subscription.findUnique({ where: { id: id ?? '' } });
    if (!sub) throw badRequest('任务没有关联订阅');
    return sub;
  }

  /**
   * 锁住任务行再处理，避免两个人同时操作同一个任务。
   * 别人正在处理的任务不能直接接手，要先转交。
   */
  private async lockOpenTask(
    tx: Tx,
    id: string,
    user: AuthUser,
    opts: { allowOthersInProgress?: boolean } = {},
  ) {
    await tx.$queryRaw`SELECT id FROM "FulfillmentTask" WHERE id = ${id} FOR UPDATE`;
    const task = await tx.fulfillmentTask.findUnique({
      where: { id },
      include: { assignee: { select: userBriefSelect } },
    });
    if (!task) throw notFound('任务');
    if (!OPEN.includes(task.status)) throw badRequest('任务已经结束');
    if (
      !opts.allowOthersInProgress &&
      task.status === 'IN_PROGRESS' &&
      task.assigneeId &&
      task.assigneeId !== user.id
    ) {
      throw new ForbiddenException({
        code: 'TASK_TAKEN',
        message: `${task.assignee?.displayName ?? '其他同事'}正在处理这个任务，需要接手请先转交`,
      });
    }
    return task;
  }
}

// ─────────────── Controller ───────────────

@ApiTags('履约任务')
@ApiBearerAuth()
@Controller('tasks')
@RequirePermissions('fulfillment:handle')
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @ApiOperation({ summary: '任务列表（任务工作台）' })
  @ApiOkResponse({ type: TaskListDto })
  list(@Query() q: TaskQueryDto, @CurrentUser() user: AuthUser): Promise<TaskListDto> {
    return this.tasks.list(q, user);
  }

  @Get(':id')
  @ApiOperation({ summary: '任务详情' })
  @ApiOkResponse({ type: TaskDto })
  get(@Param('id') id: string): Promise<TaskDto> {
    return this.tasks.get(id);
  }

  @Post(':id/claim')
  @HttpCode(200)
  @Audit('task.claim', '领取任务')
  @ApiOperation({ summary: '领取 / 开始处理' })
  @ApiOkResponse({ type: TaskDto })
  claim(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<TaskDto> {
    return this.tasks.claim(id, user);
  }

  @Post(':id/assign')
  @HttpCode(200)
  @Audit('task.assign', '转交任务')
  @ApiOperation({ summary: '转交给其他充值员，或放回任务池' })
  @ApiOkResponse({ type: TaskDto })
  assign(
    @Param('id') id: string,
    @Body() dto: AssignTaskDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TaskDto> {
    return this.tasks.assign(id, dto.assigneeId ?? null, user);
  }

  @Post(':id/complete')
  @HttpCode(200)
  @Audit('task.complete', '完成任务')
  @ApiOperation({ summary: '完成任务（自动更新订阅、账号和订单）' })
  @ApiOkResponse({ type: TaskDto })
  complete(
    @Param('id') id: string,
    @Body() dto: CompleteTaskDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TaskDto> {
    return this.tasks.complete(id, dto, user);
  }

  @Post(':id/fail')
  @HttpCode(200)
  @Audit('task.fail', '任务标记失败')
  @ApiOperation({ summary: '标记失败（之后可以重新处理）' })
  @ApiOkResponse({ type: TaskDto })
  fail(
    @Param('id') id: string,
    @Body() dto: TaskNoteDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TaskDto> {
    return this.tasks.fail(id, dto.note, user);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Audit('task.cancel', '作废任务')
  @ApiOperation({ summary: '作废「取消自动续订 / 回收成品号」任务' })
  @ApiOkResponse({ type: TaskDto })
  cancel(
    @Param('id') id: string,
    @Body() dto: TaskNoteDto,
    @CurrentUser() user: AuthUser,
  ): Promise<TaskDto> {
    return this.tasks.cancel(id, dto.note, user);
  }
}

@Module({
  imports: [FulfillmentModule, LedgerModule],
  providers: [TasksService],
  controllers: [TasksController],
})
export class TasksModule {}
