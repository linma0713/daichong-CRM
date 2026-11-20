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
import { Prisma } from '@prisma/client';
import {
  COST_KINDS,
  FULFILLMENT_TYPES,
  ORDER_STATUSES,
  PAYMENT_METHOD_VALUES,
  REFUND_STATUSES,
  TASK_STATUSES,
  TASK_TYPES,
  displayNo,
  feeOf,
  hasPermission,
  parseNo,
  type CostKind,
  type FulfillmentType,
  type OrderKind,
  type OrderStatus,
  type PaymentMethod,
  type RefundStatus,
  type TaskStatus,
  type TaskType,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { Audit, CurrentUser, RequirePermissions } from '../auth/decorators';
import type { AuthUser } from '../common/auth-user';
import {
  CustomerBriefDto,
  UserBriefDto,
  customerBriefSelect,
  userBriefSelect,
} from '../common/briefs';
import { scopeWhere } from '../common/data-scope';
import { badRequest, notFound } from '../common/errors';
import { PageQueryDto, skipTake } from '../common/pagination';
import { SecretBox } from '../common/secret-box';
import { productName } from '../catalog/catalog';
import { visibleCustomers } from '../customers/customers';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { FulfillmentService, type Tx } from '../fulfillment/fulfillment.service';
import { SettingsModule, SettingsService } from '../settings/settings';

const ORDER_KINDS: OrderKind[] = ['NEW', 'RENEWAL'];

// ─────────────── DTO ───────────────

export class OrderQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '订单编号或客户称呼' })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({ enum: ORDER_STATUSES, enumName: 'OrderStatus' })
  @IsOptional()
  @IsIn(ORDER_STATUSES)
  status?: OrderStatus;

  @ApiPropertyOptional({ enum: ORDER_KINDS, enumName: 'OrderKind' })
  @IsOptional()
  @IsIn(ORDER_KINDS)
  kind?: OrderKind;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subscriptionId?: string;
}

export class CreateOrderDto {
  @ApiProperty()
  @IsString()
  customerId: string;

  @ApiProperty({ enum: ORDER_KINDS, enumName: 'OrderKind' })
  @IsIn(ORDER_KINDS)
  kind: OrderKind;

  @ApiProperty()
  @IsString()
  productId: string;

  @ApiPropertyOptional({ description: '续费订单：要续费的订阅' })
  @IsOptional()
  @IsString()
  subscriptionId?: string;

  @ApiPropertyOptional({ description: '优惠（分）', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  discountCents?: number;

  @ApiPropertyOptional({ description: '加购质保（按商品设置的质保价计入应收）' })
  @IsOptional()
  @IsBoolean()
  withWarranty?: boolean;

  @ApiPropertyOptional({ description: '代充新购：客户的 Claude 账号邮箱' })
  @IsOptional()
  @IsEmail({}, { message: 'Claude 账号邮箱格式不正确' })
  accountEmail?: string;

  @ApiPropertyOptional({ description: '代充新购：客户的 Claude 账号密码（加密保存）' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  accountPassword?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

export class AddPaymentDto {
  @ApiProperty({ description: '收款金额（分）' })
  @IsInt()
  @Min(1, { message: '收款金额必须大于 0' })
  @Max(100_000_00)
  amountCents: number;

  @ApiProperty({ enum: PAYMENT_METHOD_VALUES })
  @IsIn(PAYMENT_METHOD_VALUES)
  method: PaymentMethod;

  @ApiPropertyOptional({ description: '转账单号或备注' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;

  @ApiPropertyOptional({ description: '到账时间，不填为现在' })
  @IsOptional()
  @IsDateString()
  receivedAt?: string;
}

export class CancelOrderDto {
  @ApiProperty({ example: '客户不买了' })
  @IsString()
  @IsNotEmpty({ message: '请填写取消原因' })
  @MaxLength(200)
  reason: string;
}

export class RefDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
}

export class OrderDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'D00012' }) code: string;
  @ApiProperty({ enum: ORDER_KINDS, enumName: 'OrderKind' }) kind: OrderKind;
  @ApiProperty({ enum: ORDER_STATUSES, enumName: 'OrderStatus' }) status: OrderStatus;
  @ApiProperty({ type: CustomerBriefDto }) customer: CustomerBriefDto;
  @ApiProperty() productId: string;
  @ApiProperty({ example: 'Max 季付（代充）' }) productName: string;
  @ApiProperty() planName: string;
  @ApiProperty() termMonths: number;
  @ApiProperty({ enum: FULFILLMENT_TYPES, enumName: 'FulfillmentType' })
  fulfillmentType: FulfillmentType;
  @ApiProperty() listPriceCents: number;
  @ApiProperty() discountCents: number;
  @ApiProperty({ description: '是否加购质保' }) withWarranty: boolean;
  @ApiProperty({ description: '质保费（分），已含在应收里' }) warrantyCents: number;
  @ApiProperty({ description: '应收（分）= 标价 − 优惠 + 质保费' }) amountCents: number;
  @ApiProperty({ description: '已收（分）' }) paidCents: number;
  @ApiProperty({ description: '已退款（分）' }) refundedCents: number;
  @ApiProperty({ type: String, nullable: true }) accountId: string | null;
  @ApiProperty({ type: String, nullable: true }) accountEmail: string | null;
  @ApiProperty({ type: RefDto, nullable: true }) subscription: RefDto | null;
  @ApiProperty({ type: UserBriefDto, description: '负责客服' }) owner: UserBriefDto;
  @ApiProperty({ type: UserBriefDto }) createdBy: UserBriefDto;
  @ApiProperty({ type: String, nullable: true }) remark: string | null;
  @ApiProperty({ type: String, nullable: true }) paidAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) completedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) cancelledAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) cancelReason: string | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: '毛利（分）= 已收 − 已退款 − 手续费 − 已发生成本；没有「查看成本」权限时为空',
  })
  marginCents: number | null;
  @ApiProperty() createdAt: Date;
}

export class OrderListDto {
  @ApiProperty({ type: [OrderDto] }) items: OrderDto[];
  @ApiProperty() total: number;
}

export class PaymentDto {
  @ApiProperty() id: string;
  @ApiProperty() amountCents: number;
  @ApiProperty({ description: '收款手续费（分）' }) feeCents: number;
  @ApiProperty({ enum: PAYMENT_METHOD_VALUES }) method: string;
  @ApiProperty({ type: String, nullable: true }) reference: string | null;
  @ApiProperty() receivedAt: Date;
  @ApiProperty({ type: UserBriefDto }) confirmedBy: UserBriefDto;
  @ApiProperty() createdAt: Date;
}

export class TaskBriefDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty({ enum: TASK_TYPES, enumName: 'TaskType' }) type: TaskType;
  @ApiProperty({ enum: TASK_STATUSES, enumName: 'TaskStatus' }) status: TaskStatus;
  @ApiProperty({ type: UserBriefDto, nullable: true }) assignee: UserBriefDto | null;
  @ApiProperty() dueAt: Date;
  @ApiProperty({ type: String, nullable: true }) finishedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
}

export class CostEntryDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: COST_KINDS, enumName: 'CostKind' }) kind: CostKind;
  @ApiProperty({ description: '人民币成本（分）' }) amountCents: number;
  @ApiProperty({ type: Number, nullable: true, description: '上游扣费美元（美分，含手续费）' })
  usdCents: number | null;
  @ApiProperty({ type: String, nullable: true, description: '用的付款资源' }) resourceName:
    string | null;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty({ type: UserBriefDto }) user: UserBriefDto;
  @ApiProperty() createdAt: Date;
}

export class OrderProfitDto {
  @ApiProperty({ description: '已收（分）' }) revenueCents: number;
  @ApiProperty({ description: '已退款（分）' }) refundedCents: number;
  @ApiProperty({ description: '收款手续费（分）' }) feeCents: number;
  @ApiProperty({ description: '已发生成本（分）' }) costCents: number;
  @ApiProperty({ description: '毛利（分）= 已收 − 已退款 − 手续费 − 已发生成本' })
  marginCents: number;
  @ApiProperty({ type: Number, nullable: true, description: '毛利率（0–1）' }) marginRate:
    number | null;
  @ApiProperty({ description: '已登记的上游扣费次数（含成品号成本）' }) chargesDone: number;
  @ApiProperty({ description: '服务期内应有的上游扣费次数（= 服务月数）' }) chargesExpected: number;
  @ApiProperty({ description: '还没发生的上游扣费，按当前汇率和官方月费估算（分）' })
  estRemainingCostCents: number;
  @ApiProperty({ description: '预计毛利（分）= 毛利 − 预计还要发生的成本' }) estMarginCents: number;
  @ApiProperty({ type: [CostEntryDto] }) costs: CostEntryDto[];
}

export class OrderRefundDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'K00003' }) code: string;
  @ApiProperty() amountCents: number;
  @ApiProperty({ enum: REFUND_STATUSES, enumName: 'RefundStatus' }) status: RefundStatus;
  @ApiProperty() reason: string;
  @ApiProperty({ description: '退款后终止服务' }) terminate: boolean;
  @ApiProperty({ type: RefDto, nullable: true, description: '来自哪个售后工单' })
  ticket: RefDto | null;
  @ApiProperty({ type: UserBriefDto }) requestedBy: UserBriefDto;
  @ApiProperty({ type: String, nullable: true, description: '退款方式' }) method: string | null;
  @ApiProperty({ type: String, nullable: true }) paidAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) rejectReason: string | null;
  @ApiProperty() createdAt: Date;
}

export class OrderDetailDto extends OrderDto {
  @ApiProperty({ type: [PaymentDto] }) payments: PaymentDto[];
  @ApiProperty({ type: [TaskBriefDto] }) tasks: TaskBriefDto[];
  @ApiProperty({ type: [OrderRefundDto] }) refunds: OrderRefundDto[];
  @ApiProperty({ description: '还可以申请退款的金额（分）= 已收 − 已退 − 审批中' })
  refundableCents: number;
  @ApiProperty({ type: OrderProfitDto, nullable: true, description: '有「查看成本」权限时返回' })
  profit: OrderProfitDto | null;
}

// ─────────────── Service ───────────────

const orderInclude = {
  customer: { select: customerBriefSelect },
  subscription: { select: { id: true, no: true } },
  owner: { select: userBriefSelect },
  createdBy: { select: userBriefSelect },
} satisfies Prisma.OrderInclude;
type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

export function toCustomerBrief(c: {
  id: string;
  no: number;
  name: string;
  wechat: string | null;
  telegram: string | null;
}): CustomerBriefDto {
  return {
    id: c.id,
    code: displayNo('C', c.no),
    name: c.name,
    wechat: c.wechat,
    telegram: c.telegram,
  };
}

/** 毛利 = 已收 − 已退款 − 手续费 − 已发生成本 */
export function orderMargin(o: {
  paidCents: number;
  refundedCents: number;
  feeCents: number;
  costCents: number;
}): number {
  return o.paidCents - o.refundedCents - o.feeCents - o.costCents;
}

export const canSeeCost = (user: AuthUser) => hasPermission(user.permissions, 'finance:read');

function toOrderDto(o: OrderRow, user: AuthUser): OrderDto {
  return {
    id: o.id,
    code: displayNo('D', o.no),
    kind: o.kind,
    status: o.status,
    customer: toCustomerBrief(o.customer),
    productId: o.productId,
    productName: productName(o.planName, o.termMonths, o.fulfillmentType),
    planName: o.planName,
    termMonths: o.termMonths,
    fulfillmentType: o.fulfillmentType,
    listPriceCents: o.listPriceCents,
    discountCents: o.discountCents,
    withWarranty: o.withWarranty,
    warrantyCents: o.warrantyCents,
    amountCents: o.amountCents,
    paidCents: o.paidCents,
    refundedCents: o.refundedCents,
    accountId: o.accountId,
    accountEmail: o.accountEmail,
    subscription: o.subscription
      ? { id: o.subscription.id, code: displayNo('S', o.subscription.no) }
      : null,
    owner: o.owner,
    createdBy: o.createdBy,
    remark: o.remark,
    paidAt: o.paidAt,
    completedAt: o.completedAt,
    cancelledAt: o.cancelledAt,
    cancelReason: o.cancelReason,
    marginCents: canSeeCost(user) ? orderMargin(o) : null,
    createdAt: o.createdAt,
  };
}

export function visibleOrders(user: AuthUser): Prisma.OrderWhereInput {
  return scopeWhere(user);
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfillment: FulfillmentService,
    private readonly secrets: SecretBox,
    private readonly settings: SettingsService,
  ) {}

  async list(q: OrderQueryDto, user: AuthUser): Promise<OrderListDto> {
    const no = parseNo(q.keyword, 'D');
    const kw = q.keyword?.trim();
    const where: Prisma.OrderWhereInput = {
      AND: [visibleOrders(user)],
      status: q.status,
      kind: q.kind,
      customerId: q.customerId,
      subscriptionId: q.subscriptionId,
      OR: kw
        ? [
            ...(no !== undefined ? [{ no }] : []),
            { customer: { name: { contains: kw, mode: 'insensitive' } } },
            { accountEmail: { contains: kw, mode: 'insensitive' } },
          ]
        : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        include: orderInclude,
        orderBy: { createdAt: 'desc' },
        ...skipTake(q),
      }),
      this.prisma.order.count({ where }),
    ]);
    return { items: rows.map((o) => toOrderDto(o, user)), total };
  }

  async get(id: string, user: AuthUser): Promise<OrderDetailDto> {
    const o = await this.prisma.order.findFirst({
      where: { id, ...visibleOrders(user) },
      include: {
        ...orderInclude,
        payments: {
          include: { confirmedBy: { select: userBriefSelect } },
          orderBy: { receivedAt: 'asc' },
        },
        tasks: {
          include: { assignee: { select: userBriefSelect } },
          orderBy: { createdAt: 'asc' },
        },
        refunds: {
          include: {
            requestedBy: { select: userBriefSelect },
            ticket: { select: { id: true, no: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!o) throw notFound('订单');
    const pending = o.refunds
      .filter((r) => r.status === 'PENDING')
      .reduce((sum, r) => sum + r.amountCents, 0);
    const terminated = o.refunds.some((r) => r.status === 'PAID' && r.terminate);
    return {
      ...toOrderDto(o, user),
      profit: canSeeCost(user) ? await this.profit(o, terminated) : null,
      refunds: o.refunds.map((r) => ({
        id: r.id,
        code: displayNo('K', r.no),
        amountCents: r.amountCents,
        status: r.status,
        reason: r.reason,
        terminate: r.terminate,
        ticket: r.ticket ? { id: r.ticket.id, code: displayNo('G', r.ticket.no) } : null,
        requestedBy: r.requestedBy,
        method: r.method,
        paidAt: r.paidAt,
        rejectReason: r.rejectReason,
        createdAt: r.createdAt,
      })),
      refundableCents: Math.max(0, o.paidCents - o.refundedCents - pending),
      payments: o.payments.map((p) => ({
        id: p.id,
        amountCents: p.amountCents,
        feeCents: p.feeCents,
        method: p.method,
        reference: p.reference,
        receivedAt: p.receivedAt,
        confirmedBy: p.confirmedBy,
        createdAt: p.createdAt,
      })),
      tasks: o.tasks.map((t) => ({
        id: t.id,
        code: displayNo('T', t.no),
        type: t.type,
        status: t.status,
        assignee: t.assignee,
        dueAt: t.dueAt,
        finishedAt: t.finishedAt,
        note: t.note,
      })),
    };
  }

  /** 每单毛利：已发生的成本 + 按服务月数估算还要发生的上游扣费（退款终止服务后不再估算） */
  private async profit(
    o: {
      id: string;
      status: OrderStatus;
      productId: string;
      termMonths: number;
      paidCents: number;
      refundedCents: number;
      feeCents: number;
      costCents: number;
    },
    terminated: boolean,
  ): Promise<OrderProfitDto> {
    const [entries, product, { exchangeRate }] = await Promise.all([
      this.prisma.costEntry.findMany({
        where: { orderId: o.id },
        include: {
          user: { select: userBriefSelect },
          resourceTx: { select: { resource: { select: { name: true } } } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.product.findUnique({ where: { id: o.productId }, include: { plan: true } }),
      this.settings.getAll(),
    ]);
    const marginCents = orderMargin(o);
    const chargesDone = entries.filter((e) => e.kind !== 'OTHER').length;
    const chargesExpected = o.status === 'CANCELLED' || terminated ? chargesDone : o.termMonths;
    const monthly = product?.plan.upstreamMonthlyUsdCents ?? 0;
    const estRemainingCostCents = Math.round(
      Math.max(0, chargesExpected - chargesDone) * monthly * exchangeRate,
    );
    return {
      revenueCents: o.paidCents,
      refundedCents: o.refundedCents,
      feeCents: o.feeCents,
      costCents: o.costCents,
      marginCents,
      marginRate: o.paidCents > 0 ? Math.round((marginCents / o.paidCents) * 1000) / 1000 : null,
      chargesDone,
      chargesExpected,
      estRemainingCostCents,
      estMarginCents: marginCents - estRemainingCostCents,
      costs: entries.map((e) => ({
        id: e.id,
        kind: e.kind,
        amountCents: e.amountCents,
        usdCents: e.usdCents,
        resourceName: e.resourceTx?.resource.name ?? null,
        note: e.note,
        user: e.user,
        createdAt: e.createdAt,
      })),
    };
  }

  async create(dto: CreateOrderDto, user: AuthUser): Promise<OrderDetailDto> {
    const customer = await this.prisma.customer.findFirst({
      where: { id: dto.customerId, ...visibleCustomers(user) },
      include: { owner: { select: { id: true, teamId: true } } },
    });
    if (!customer) throw notFound('客户');
    const product = await this.prisma.product.findUnique({
      where: { id: dto.productId },
      include: { plan: true },
    });
    if (!product || !product.active || !product.plan.active) throw badRequest('商品不存在或已下架');
    const discount = dto.discountCents ?? 0;
    if (discount > product.priceCents) throw badRequest('优惠不能超过售价');
    if (dto.withWarranty && product.warrantyPriceCents === null) {
      throw badRequest('这个商品没有设置质保价，不能加购质保');
    }
    const warrantyCents = dto.withWarranty ? (product.warrantyPriceCents ?? 0) : 0;

    const id = await this.prisma.$transaction(async (tx) => {
      let accountId: string | null = null;
      let accountEmail: string | null = null;
      let subscriptionId: string | null = null;

      if (dto.kind === 'RENEWAL') {
        if (!dto.subscriptionId) throw badRequest('续费订单要选择续费哪个订阅');
        const sub = await tx.subscription.findFirst({
          where: { id: dto.subscriptionId, customerId: customer.id },
          include: { account: true },
        });
        if (!sub) throw badRequest('订阅不属于这个客户');
        if (sub.status === 'CANCELLED') throw badRequest('订阅已终止，请下新购订单');
        if (sub.fulfillmentType !== product.fulfillmentType) {
          throw badRequest('续费的履约方式要和原订阅一致（代充续代充、成品号续成品号）');
        }
        const pending = await tx.order.findFirst({
          where: { subscriptionId: sub.id, status: { in: ['PENDING_PAYMENT', 'FULFILLING'] } },
        });
        if (pending) {
          throw badRequest(`这个订阅已有未完成的续费订单 ${displayNo('D', pending.no)}`);
        }
        subscriptionId = sub.id;
        accountId = sub.accountId;
        accountEmail = sub.account.email;
      } else if (product.fulfillmentType === 'RECHARGE') {
        if (!dto.accountEmail) throw badRequest('代充订单要填写客户的 Claude 账号邮箱');
        const account = await this.upsertCustomerAccount(
          tx,
          customer.id,
          dto.accountEmail,
          dto.accountPassword,
        );
        accountId = account.id;
        accountEmail = account.email;
      }

      const order = await tx.order.create({
        data: {
          kind: dto.kind,
          customerId: customer.id,
          productId: product.id,
          subscriptionId,
          planName: product.plan.name,
          termMonths: product.termMonths,
          fulfillmentType: product.fulfillmentType,
          listPriceCents: product.priceCents,
          discountCents: discount,
          withWarranty: !!dto.withWarranty,
          warrantyCents,
          amountCents: product.priceCents - discount + warrantyCents,
          accountId,
          accountEmail,
          remark: dto.remark?.trim() || null,
          ownerId: customer.ownerId,
          teamId: customer.owner.teamId,
          createdById: user.id,
        },
      });
      // 0 元订单（例如赠送）直接进入开通
      if (order.amountCents === 0) await this.markPaid(tx, order.id);
      return order.id;
    });
    return this.get(id, user);
  }

  /** 确认收款；收齐后自动建开通 / 续费任务 */
  async addPayment(id: string, dto: AddPaymentDto, user: AuthUser): Promise<OrderDetailDto> {
    const { paymentFeeBp } = await this.settings.getAll();
    const feeCents = feeOf(dto.amountCents, paymentFeeBp[dto.method] ?? 0);
    await this.prisma.$transaction(async (tx) => {
      // 锁住订单行，避免两个人同时确认收款
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${id} FOR UPDATE`;
      const order = await tx.order.findFirst({ where: { id, ...visibleOrders(user) } });
      if (!order) throw notFound('订单');
      if (order.status !== 'PENDING_PAYMENT') throw badRequest('只有待收款的订单可以确认收款');
      const paid = order.paidCents + dto.amountCents;
      if (paid > order.amountCents) {
        throw badRequest(`收款超过应收：还差 ${(order.amountCents - order.paidCents) / 100} 元`);
      }
      await tx.payment.create({
        data: {
          orderId: id,
          amountCents: dto.amountCents,
          feeCents,
          method: dto.method,
          reference: dto.reference?.trim() || null,
          receivedAt: dto.receivedAt ? new Date(dto.receivedAt) : new Date(),
          confirmedById: user.id,
        },
      });
      await tx.order.update({
        where: { id },
        data: { paidCents: paid, feeCents: { increment: feeCents } },
      });
      if (paid === order.amountCents) await this.markPaid(tx, id);
    });
    return this.get(id, user);
  }

  async cancel(id: string, reason: string, user: AuthUser): Promise<OrderDetailDto> {
    const order = await this.prisma.order.findFirst({ where: { id, ...visibleOrders(user) } });
    if (!order) throw notFound('订单');
    if (order.status !== 'PENDING_PAYMENT') throw badRequest('只有待收款的订单可以取消');
    if (order.paidCents > 0) throw badRequest('订单已经收过款，不能直接取消（退款在售后模块处理）');
    await this.prisma.order.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason.trim() },
    });
    return this.get(id, user);
  }

  private async markPaid(tx: Tx, id: string): Promise<void> {
    const order = await tx.order.update({
      where: { id },
      data: { status: 'FULFILLING', paidAt: new Date() },
    });
    await this.fulfillment.onOrderPaid(tx, order);
  }

  /**
   * 代充新购：记录客户的 Claude 账号。同一个邮箱只能属于一个客户；
   * 已有服务中订阅的账号要走续费，不能重复新购。
   */
  private async upsertCustomerAccount(
    tx: Tx,
    customerId: string,
    rawEmail: string,
    password: string | undefined,
  ) {
    const email = rawEmail.trim().toLowerCase();
    const existing = await tx.claudeAccount.findUnique({
      where: { email },
      include: {
        customer: { select: { no: true } },
        subscriptions: { where: { status: 'ACTIVE' }, select: { no: true } },
      },
    });
    if (!existing) {
      return tx.claudeAccount.create({
        data: {
          email,
          ownership: 'CUSTOMER',
          customerId,
          passwordEnc: this.secrets.encryptOptional(password),
        },
      });
    }
    if (existing.ownership === 'COMPANY')
      throw badRequest('这个邮箱是公司的成品号，不能作为客户账号');
    if (existing.customerId && existing.customerId !== customerId) {
      throw badRequest(`这个账号已登记在客户 ${displayNo('C', existing.customer!.no)} 名下`);
    }
    if (existing.subscriptions.length > 0) {
      throw badRequest(
        `这个账号已有服务中的订阅 ${displayNo('S', existing.subscriptions[0].no)}，请下续费订单`,
      );
    }
    return tx.claudeAccount.update({
      where: { id: existing.id },
      data: {
        customerId,
        ...(password ? { passwordEnc: this.secrets.encrypt(password) } : {}),
      },
    });
  }
}

// ─────────────── Controller ───────────────

@ApiTags('订单与收款')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  @RequirePermissions('order:read')
  @ApiOperation({ summary: '订单列表（按数据范围）' })
  @ApiOkResponse({ type: OrderListDto })
  list(@Query() q: OrderQueryDto, @CurrentUser() user: AuthUser): Promise<OrderListDto> {
    return this.orders.list(q, user);
  }

  @Get(':id')
  @RequirePermissions('order:read')
  @ApiOperation({ summary: '订单详情（含收款记录和任务）' })
  @ApiOkResponse({ type: OrderDetailDto })
  get(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<OrderDetailDto> {
    return this.orders.get(id, user);
  }

  @Post()
  @RequirePermissions('order:write')
  @Audit('order.create', '录入订单')
  @ApiOperation({ summary: '录入订单（新购 / 续费）' })
  @ApiOkResponse({ type: OrderDetailDto })
  create(@Body() dto: CreateOrderDto, @CurrentUser() user: AuthUser): Promise<OrderDetailDto> {
    return this.orders.create(dto, user);
  }

  @Post(':id/payments')
  @HttpCode(200)
  @RequirePermissions('payment:confirm')
  @Audit('order.payment', '确认收款')
  @ApiOperation({ summary: '确认收款（收齐后自动派开通 / 续费任务）' })
  @ApiOkResponse({ type: OrderDetailDto })
  addPayment(
    @Param('id') id: string,
    @Body() dto: AddPaymentDto,
    @CurrentUser() user: AuthUser,
  ): Promise<OrderDetailDto> {
    return this.orders.addPayment(id, dto, user);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('order:write')
  @Audit('order.cancel', '取消订单')
  @ApiOperation({ summary: '取消订单（只能取消没收过款的）' })
  @ApiOkResponse({ type: OrderDetailDto })
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
    @CurrentUser() user: AuthUser,
  ): Promise<OrderDetailDto> {
    return this.orders.cancel(id, dto.reason, user);
  }
}

@Module({
  imports: [FulfillmentModule, SettingsModule],
  providers: [OrdersService],
  controllers: [OrdersController],
})
export class OrdersModule {}
