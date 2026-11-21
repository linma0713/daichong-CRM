import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Logger,
  Module,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import type { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  PAY_CHANNEL_LABELS,
  PAYMENT_LINK_STATUSES,
  displayNo,
  feeOf,
  formatCents,
  parseNo,
  termLabel,
  type PaymentLinkStatus,
  type PaymentMethod,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  Audit,
  CurrentUser,
  Public,
  RequireAnyPermission,
  RequirePermissions,
  SkipAudit,
} from '../auth/decorators';
import type { AuthUser } from '../common/auth-user';
import { userBriefSelect } from '../common/briefs';
import { addDays } from '../common/dates';
import { badRequest, notFound } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { NotifyService } from '../notify/notify';
import { SettingsModule, SettingsService } from '../settings/settings';
import { OrdersModule, OrdersService, visibleOrders } from '../orders/orders';
import { productName } from '../catalog/catalog';
import { PaymentLinkDto, effectiveLinkStatus, toPaymentLinkDto } from './links';

// ─────────────── 收款通道 ───────────────

/** 支付平台通知我们「这笔钱到了」，验签通过后整理成这个样子 */
export interface PayNotice {
  /** 我们的交易号，就是收款链接编号 P00012 */
  tradeNo: string;
  /** 支付平台的交易号 */
  channelTradeNo: string;
  amountCents: number;
  paidAt: Date;
}

/**
 * 一个收款通道（支付平台）。接真实通道时实现这个接口并注册到 GATEWAYS：
 * - create：向平台下单，拿到付款地址（客户打开付款页后跳过去）
 * - verify：校验回调签名，解析出到账信息；签名不对直接抛错
 * - ack：回给平台的应答（平台收不到「成功」会反复重试）
 */
export interface PaymentGateway {
  channel: string;
  /** 记收款时用的收款方式，决定手续费率 */
  method: PaymentMethod;
  create(input: {
    tradeNo: string;
    amountCents: number;
    subject: string;
    expiresAt: Date;
  }): Promise<{ payUrl: string | null }>;
  verify(payload: unknown): PayNotice;
  ack(ok: boolean): { status: number; body: unknown };
}

/**
 * 模拟通道：不经过任何支付平台，客户付款页上直接有「模拟付款成功」按钮，
 * 点了以后按真实回调的格式签名、走同一套验签和记账流程。只用于测试，拿到链接的人都能点。
 */
export class MockGateway implements PaymentGateway {
  readonly channel = 'mock';
  readonly method: PaymentMethod = 'other';

  constructor(private readonly key: Buffer) {}

  async create(): Promise<{ payUrl: string | null }> {
    return { payUrl: null };
  }

  sign(n: {
    tradeNo: string;
    channelTradeNo: string;
    amountCents: number;
    paidAt: string;
  }): string {
    return createHmac('sha256', this.key)
      .update(`${n.tradeNo}|${n.channelTradeNo}|${n.amountCents}|${n.paidAt}`)
      .digest('hex');
  }

  /** 生成一条和平台回调同样格式的通知 */
  buildNotice(tradeNo: string, amountCents: number, now = new Date()): Record<string, unknown> {
    const body = {
      tradeNo,
      channelTradeNo: `MOCK${now.getTime()}${randomBytes(3).toString('hex').toUpperCase()}`,
      amountCents,
      paidAt: now.toISOString(),
    };
    return { ...body, sign: this.sign(body) };
  }

  verify(payload: unknown): PayNotice {
    const p = (payload ?? {}) as Record<string, unknown>;
    const { tradeNo, channelTradeNo, amountCents, paidAt, sign } = p;
    if (
      typeof tradeNo !== 'string' ||
      typeof channelTradeNo !== 'string' ||
      typeof amountCents !== 'number' ||
      !Number.isInteger(amountCents) ||
      typeof paidAt !== 'string' ||
      typeof sign !== 'string'
    ) {
      throw new Error('字段不全');
    }
    const expected = Buffer.from(this.sign({ tradeNo, channelTradeNo, amountCents, paidAt }));
    const actual = Buffer.from(sign);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new Error('签名不对');
    }
    const at = new Date(paidAt);
    if (Number.isNaN(at.getTime())) throw new Error('到账时间格式不对');
    return { tradeNo, channelTradeNo, amountCents, paidAt: at };
  }

  ack(ok: boolean) {
    return { status: ok ? 200 : 400, body: { ok } };
  }
}

// ─────────────── DTO ───────────────

export class CreatePaymentLinkDto {
  @ApiPropertyOptional({ description: '收款金额（分），不填就是订单还差的金额' })
  @IsOptional()
  @IsInt()
  @Min(1, { message: '收款金额必须大于 0' })
  @Max(100_000_00)
  amountCents?: number;
}

/** 客户打开付款页看到的信息（不需要登录，所以只给最少的信息） */
export class PublicPayInfoDto {
  @ApiProperty({ description: '店铺名称（业务设置里填），没填为空字符串' }) shopName: string;
  @ApiProperty({ example: 'D00012' }) orderCode: string;
  @ApiProperty({ example: 'Max 季付（代充）' }) productName: string;
  @ApiProperty() amountCents: number;
  @ApiProperty({ enum: PAYMENT_LINK_STATUSES, enumName: 'PaymentLinkStatus' })
  status: PaymentLinkStatus;
  @ApiProperty({ example: 'mock' }) channel: string;
  @ApiProperty({ description: '模拟通道：页面上显示「模拟付款成功」按钮' }) mock: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '真实通道的付款地址（跳转过去付款）；模拟通道为空',
  })
  payUrl: string | null;
  @ApiProperty() expiresAt: Date;
  @ApiProperty({ type: String, nullable: true }) paidAt: Date | null;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
/** 回调内容太大就只存开头，免得有人往回调地址灌垃圾把库撑大 */
const MAX_PAYLOAD_CHARS = 8_000;

function linkGone(): NotFoundException {
  return new NotFoundException({
    code: 'NOT_FOUND',
    message: '付款链接不存在，请联系客服重新获取',
  });
}

function storedPayload(payload: unknown): Prisma.InputJsonValue {
  let text: string;
  try {
    text = JSON.stringify(payload ?? null) ?? 'null';
  } catch {
    return { unreadable: true };
  }
  if (text.length <= MAX_PAYLOAD_CHARS) return (payload ?? null) as Prisma.InputJsonValue;
  return { truncated: text.slice(0, 2_000), length: text.length };
}

// ─────────────── Service ───────────────

const linkInclude = { createdBy: { select: userBriefSelect } } satisfies Prisma.PaymentLinkInclude;

@Injectable()
export class OnlinePaymentService {
  private readonly logger = new Logger(OnlinePaymentService.name);
  private readonly publicUrl?: string;
  readonly mock: MockGateway;
  private readonly gateways: Map<string, PaymentGateway>;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly orders: OrdersService,
    private readonly notify: NotifyService,
    private readonly audit: AuditService,
  ) {
    this.publicUrl = config.get<string>('APP_PUBLIC_URL') || undefined;
    // 模拟通道的签名密钥从 ACCOUNT_SECRET_KEY 派生，不用另外配置
    const key = createHmac(
      'sha256',
      Buffer.from(config.getOrThrow<string>('ACCOUNT_SECRET_KEY'), 'hex'),
    )
      .update('mock-pay-notify-v1')
      .digest();
    this.mock = new MockGateway(key);
    this.gateways = new Map<string, PaymentGateway>([[this.mock.channel, this.mock]]);
  }

  /** 员工给订单生成收款链接；同一订单之前还没付的链接会失效，只留最新的一条 */
  async create(
    orderId: string,
    dto: CreatePaymentLinkDto,
    user: AuthUser,
  ): Promise<PaymentLinkDto> {
    const { onlinePayChannel, payLinkMinutes } = await this.settings.getAll();
    const gateway = this.gateways.get(onlinePayChannel);
    if (!gateway) {
      throw badRequest('还没开启在线收款：请管理员在「业务设置 → 在线收款」里选择收款通道');
    }
    const link = await this.prisma.$transaction(async (tx) => {
      const order = await this.orders.lockOrder(tx, orderId, visibleOrders(user));
      if (!order) throw notFound('订单');
      if (order.status !== 'PENDING_PAYMENT') throw badRequest('只有待收款的订单可以发收款链接');
      const remaining = order.amountCents - order.paidCents;
      const amountCents = dto.amountCents ?? remaining;
      if (amountCents > remaining) {
        throw badRequest(`收款金额超过订单还差的 ${formatCents(remaining)}`);
      }
      await this.orders.closePendingLinks(tx, order.id);
      const created = await tx.paymentLink.create({
        data: {
          orderId: order.id,
          channel: gateway.channel,
          amountCents,
          token: randomBytes(32).toString('base64url'),
          expiresAt: new Date(Date.now() + payLinkMinutes * 60_000),
          createdById: user.id,
        },
      });
      return { ...created, order };
    });
    // 向支付平台下单放在事务外面：平台慢的时候不占着订单锁
    try {
      const { payUrl } = await gateway.create({
        tradeNo: displayNo('P', link.no),
        amountCents: link.amountCents,
        subject: `订单 ${displayNo('D', link.order.no)} ${productName(link.order.planName, link.order.termMonths, link.order.fulfillmentType)}`,
        expiresAt: link.expiresAt,
      });
      if (payUrl) {
        await this.prisma.paymentLink.update({
          where: { id: link.id },
          data: { channelPayUrl: payUrl },
        });
      }
    } catch (err) {
      await this.prisma.paymentLink.update({
        where: { id: link.id },
        data: { status: 'CLOSED', closedAt: new Date() },
      });
      this.logger.error(`收款通道下单失败 ${displayNo('P', link.no)}：${(err as Error).message}`);
      throw badRequest('收款通道暂时不可用，请稍后再试或改用手工确认收款');
    }
    return this.getLink(link.id, user);
  }

  async getLink(id: string, user: AuthUser): Promise<PaymentLinkDto> {
    const link = await this.prisma.paymentLink.findFirst({
      where: { id, order: visibleOrders(user) },
      include: linkInclude,
    });
    if (!link) throw notFound('收款链接');
    return toPaymentLinkDto(link, this.publicUrl);
  }

  async close(id: string, user: AuthUser): Promise<PaymentLinkDto> {
    const link = await this.prisma.paymentLink.findFirst({
      where: { id, order: visibleOrders(user) },
    });
    if (!link) throw notFound('收款链接');
    if (link.status === 'PAID') throw badRequest('客户已经付款，链接不能关闭');
    // 带上状态条件：和到账回调同时发生时，回调先改成已付款，这里就什么都不改
    await this.prisma.paymentLink.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'CLOSED', closedAt: new Date() },
    });
    return this.getLink(id, user);
  }

  // ─── 客户付款页（不登录） ───

  async publicInfo(token: string): Promise<PublicPayInfoDto> {
    if (!TOKEN_RE.test(token)) throw linkGone();
    const link = await this.prisma.paymentLink.findUnique({
      where: { token },
      include: {
        order: { select: { no: true, planName: true, termMonths: true, fulfillmentType: true } },
      },
    });
    if (!link) throw linkGone();
    const { payShopName } = await this.settings.getAll();
    const status = effectiveLinkStatus(link);
    return {
      shopName: payShopName,
      orderCode: displayNo('D', link.order.no),
      productName: productName(
        link.order.planName,
        link.order.termMonths,
        link.order.fulfillmentType,
      ),
      amountCents: link.amountCents,
      status,
      channel: link.channel,
      mock: link.channel === this.mock.channel,
      payUrl: status === 'PENDING' ? link.channelPayUrl : null,
      expiresAt: link.expiresAt,
      paidAt: link.paidAt,
    };
  }

  /** 模拟通道：客户在付款页点「模拟付款成功」，按真实回调的格式走一遍 */
  async mockPay(token: string, ip: string | null): Promise<PublicPayInfoDto> {
    if (!TOKEN_RE.test(token)) throw linkGone();
    const link = await this.prisma.paymentLink.findUnique({ where: { token } });
    if (!link) throw linkGone();
    if (link.channel !== this.mock.channel) throw badRequest('这条链接不是模拟通道');
    const { onlinePayChannel } = await this.settings.getAll();
    if (onlinePayChannel !== this.mock.channel) {
      throw badRequest('模拟通道已经关闭，请联系客服');
    }
    const status = effectiveLinkStatus(link);
    if (status === 'EXPIRED') throw badRequest('链接已过期，请联系客服重新获取');
    if (status === 'CLOSED') throw badRequest('链接已失效，请联系客服重新获取');
    if (status === 'PENDING') {
      const payload = this.mock.buildNotice(displayNo('P', link.no), link.amountCents);
      const result = await this.handleNotify(this.mock.channel, payload, ip);
      if (result.status !== 200) throw badRequest('付款没有成功，请稍后再试或联系客服');
    }
    return this.publicInfo(token);
  }

  // ─── 支付平台回调 ───

  /**
   * 处理到账通知：验签 → 找到收款链接 → 记收款。每次回调都记一行 PaymentCallback 方便排查。
   * 同一笔重复通知只处理一次；到账但订单已取消 / 已收齐 / 金额对不上时，链接标成已付款并通知人工核对。
   */
  async handleNotify(
    channel: string,
    payload: unknown,
    ip: string | null,
  ): Promise<{ status: number; body: unknown }> {
    const log = (ok: boolean, result: string, linkId?: string) =>
      this.prisma.paymentCallback.create({
        data: {
          channel: channel.slice(0, 32),
          ok,
          result,
          payload: storedPayload(payload),
          ip,
          linkId,
        },
      });
    const gateway = this.gateways.get(channel);
    if (!gateway) {
      await log(false, '未知的收款通道');
      return { status: 404, body: { ok: false } };
    }
    let notice: PayNotice;
    try {
      notice = gateway.verify(payload);
    } catch (err) {
      await log(false, `验签失败：${(err as Error).message}`);
      return gateway.ack(false);
    }
    const no = parseNo(notice.tradeNo, 'P');
    const link = no ? await this.prisma.paymentLink.findUnique({ where: { no } }) : null;
    if (!link || link.channel !== channel) {
      await log(false, `找不到收款链接 ${notice.tradeNo}`);
      return gateway.ack(false);
    }
    try {
      const outcome = await this.settle(link.id, notice, gateway);
      await log(true, outcome.summary, link.id);
      if (!outcome.duplicate) {
        await this.audit.record({
          action: 'payment_link.paid',
          summary: '在线收款到账',
          method: 'POST',
          path: `/api/pay/notify/${channel}`,
          resourceId: link.orderId,
          detail: {
            link: displayNo('P', link.no),
            amountCents: notice.amountCents,
            channelTradeNo: notice.channelTradeNo,
            result: outcome.summary,
          },
          ip,
        });
      }
      return gateway.ack(true);
    } catch (err) {
      this.logger.error(`处理到账通知失败 ${notice.tradeNo}：${(err as Error).message}`);
      await log(false, `处理失败：${(err as Error).message}`.slice(0, 500), link.id);
      return gateway.ack(false);
    }
  }

  private async settle(
    linkId: string,
    notice: PayNotice,
    gateway: PaymentGateway,
  ): Promise<{ summary: string; duplicate: boolean }> {
    const { paymentFeeBp } = await this.settings.getAll();
    return this.prisma.$transaction(async (tx) => {
      const { orderId } = await tx.paymentLink.findUniqueOrThrow({
        where: { id: linkId },
        select: { orderId: true },
      });
      // 先锁订单再锁链接，和手工确认收款、取消订单的加锁顺序一致，避免互相等待
      const order = await this.orders.lockOrder(tx, orderId);
      if (!order) throw new Error('订单不存在');
      await tx.$queryRaw`SELECT id FROM "PaymentLink" WHERE id = ${linkId} FOR UPDATE`;
      const link = await tx.paymentLink.findUniqueOrThrow({ where: { id: linkId } });
      if (link.status === 'PAID') return { summary: '重复通知，之前已经处理过', duplicate: true };

      const code = displayNo('P', link.no);
      const remaining = order.amountCents - order.paidCents;
      let anomaly: string | null = null;
      if (notice.amountCents !== link.amountCents) {
        anomaly = `到账 ${formatCents(notice.amountCents)}，和链接金额 ${formatCents(link.amountCents)} 不一致`;
      } else if (order.status === 'CANCELLED') {
        anomaly = '订单已经取消';
      } else if (order.status !== 'PENDING_PAYMENT') {
        anomaly = '订单已经收齐款';
      } else if (notice.amountCents > remaining) {
        anomaly = `订单只差 ${formatCents(remaining)}，记这笔会超过应收`;
      }

      let paymentId: string | null = null;
      if (!anomaly) {
        paymentId = await this.orders.recordPayment(tx, order, {
          amountCents: notice.amountCents,
          feeCents: feeOf(notice.amountCents, paymentFeeBp[gateway.method] ?? 0),
          method: gateway.method,
          reference: `在线收款 ${code}`,
          channel: gateway.channel,
          externalId: notice.channelTradeNo,
          receivedAt: notice.paidAt,
          // 自动确认的收款记在发链接的员工名下
          confirmedById: link.createdById,
          methodLabel: `在线收款（${PAY_CHANNEL_LABELS[gateway.channel] ?? gateway.channel}）`,
          byLine: `客户通过收款链接 ${code} 付款，系统自动确认`,
        });
      }
      await tx.paymentLink.update({
        where: { id: link.id },
        data: {
          status: 'PAID',
          paidAt: notice.paidAt,
          channelTradeNo: notice.channelTradeNo,
          anomaly,
          paymentId,
        },
      });
      if (anomaly) {
        const customer = await tx.customer.findUniqueOrThrow({
          where: { id: order.customerId },
          select: { no: true, name: true },
        });
        const finance = await this.notify.holders(tx, 'finance:read');
        await this.notify.emit(tx, {
          event: 'payment.anomaly',
          title: `在线收款到账但没有自动记账 ${formatCents(notice.amountCents)} · 订单 ${displayNo('D', order.no)}`,
          body: [
            `客户：${customer.name}（${displayNo('C', customer.no)}） · ${order.planName} ${termLabel(order.termMonths)}`,
            `原因：${anomaly}`,
            `收款链接 ${code} · 平台交易号 ${notice.channelTradeNo}`,
            '请核对后给客户退款，或手工处理这笔钱',
          ].join('\n'),
          link: `/orders/${order.id}`,
          to: [order.ownerId, ...finance],
        });
      }
      return {
        summary: anomaly ? `已到账，没有自动记账：${anomaly}` : '已到账，已自动确认收款',
        duplicate: false,
      };
    });
  }

  // ─── 定时清理 ───

  @Cron('*/5 * * * *', {
    name: 'payment-link-expire',
    waitForCompletion: true,
    disabled: process.env.NODE_ENV === 'test',
  })
  async scheduled(): Promise<void> {
    try {
      await this.expire();
    } catch (err) {
      this.logger.error(`收款链接过期处理失败：${(err as Error).message}`);
    }
  }

  /** 过了有效期的链接标成已过期；90 天前的回调记录删掉 */
  async expire(now = new Date()): Promise<number> {
    const { count } = await this.prisma.paymentLink.updateMany({
      where: { status: 'PENDING', expiresAt: { lte: now } },
      data: { status: 'EXPIRED' },
    });
    await this.prisma.paymentCallback.deleteMany({
      where: { createdAt: { lt: addDays(now, -90) } },
    });
    return count;
  }
}

// ─────────────── Controller ───────────────

@ApiTags('在线收款')
@ApiBearerAuth()
@Controller()
export class PaymentLinksController {
  constructor(private readonly online: OnlinePaymentService) {}

  @Post('orders/:id/payment-links')
  @RequireAnyPermission('order:write', 'payment:confirm')
  @Audit('payment_link.create', '生成收款链接')
  @ApiOperation({ summary: '给订单生成在线收款链接（之前没付的链接作废）' })
  @ApiOkResponse({ type: PaymentLinkDto })
  create(
    @Param('id') id: string,
    @Body() dto: CreatePaymentLinkDto,
    @CurrentUser() user: AuthUser,
  ): Promise<PaymentLinkDto> {
    return this.online.create(id, dto, user);
  }

  @Get('payment-links/:id')
  @RequirePermissions('order:read')
  @ApiOperation({ summary: '收款链接状态（等客户付款时轮询）' })
  @ApiOkResponse({ type: PaymentLinkDto })
  get(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<PaymentLinkDto> {
    return this.online.getLink(id, user);
  }

  @Post('payment-links/:id/close')
  @HttpCode(200)
  @RequireAnyPermission('order:write', 'payment:confirm')
  @Audit('payment_link.close', '关闭收款链接')
  @ApiOperation({ summary: '关闭收款链接（客户就不能再用它付款）' })
  @ApiOkResponse({ type: PaymentLinkDto })
  close(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<PaymentLinkDto> {
    return this.online.close(id, user);
  }
}

@ApiTags('在线收款')
@Controller('pay')
@Public()
export class PublicPayController {
  constructor(private readonly online: OnlinePaymentService) {}

  @Get(':token')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: '客户付款页：订单金额和链接状态（不需要登录）' })
  @ApiOkResponse({ type: PublicPayInfoDto })
  info(@Param('token') token: string): Promise<PublicPayInfoDto> {
    return this.online.publicInfo(token);
  }

  @Post(':token/mock-pay')
  @HttpCode(200)
  @SkipAudit()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '模拟通道：模拟付款成功（只在业务设置选了模拟通道时可用）' })
  @ApiOkResponse({ type: PublicPayInfoDto })
  mockPay(@Param('token') token: string, @Req() req: Request): Promise<PublicPayInfoDto> {
    return this.online.mockPay(token, req.ip ?? null);
  }

  @Post('notify/:channel')
  // 到账结果由 handleNotify 自己记操作日志
  @SkipAudit()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: '支付平台到账回调（平台调用，验签后自动确认收款）' })
  async notify(
    @Param('channel') channel: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const { status, body: ack } = await this.online.handleNotify(channel, body, req.ip ?? null);
    res.status(status);
    if (typeof ack === 'string') res.type('text/plain').send(ack);
    else res.json(ack);
  }
}

@Module({
  imports: [OrdersModule, SettingsModule],
  providers: [OnlinePaymentService],
  controllers: [PaymentLinksController, PublicPayController],
  exports: [OnlinePaymentService],
})
export class OnlinePaymentModule {}
