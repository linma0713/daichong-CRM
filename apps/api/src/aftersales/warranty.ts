import { ApiProperty } from '@nestjs/swagger';
import { CUSTOMER_FAULTS, displayNo, formatCents, proratedRefund } from '@crm/shared';
import type { Tx } from '../fulfillment/fulfillment.service';
import type { PrismaService } from '../prisma/prisma.service';

export class WarrantyOrderDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'D00012' }) code: string;
}

/** 质保判断结果：可包换 / 可退多少 / 不在质保内（原因） */
export class WarrantyDto {
  @ApiProperty({ description: '是否在质保内' }) covered: boolean;
  @ApiProperty({ example: '可包换 · 可退 ¥190.00', description: '一句话结论' }) summary: string;
  @ApiProperty({ type: String, nullable: true, description: '不在质保内的原因' })
  reason: string | null;
  @ApiProperty({ type: WarrantyOrderDto, nullable: true, description: '按哪笔订单算' })
  order: WarrantyOrderDto | null;
  @ApiProperty({ description: '这笔订单是否加购了质保' }) withWarranty: boolean;
  @ApiProperty({ description: '质保费（分），默认不退' }) warrantyCents: number;
  @ApiProperty({ type: String, nullable: true }) periodStartAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) periodEndAt: Date | null;
  @ApiProperty() totalDays: number;
  @ApiProperty() remainingDays: number;
  @ApiProperty({ description: '套餐实付（分）= 已收 − 质保费' }) planPaidCents: number;
  @ApiProperty({ description: '按天折算可退（分），已扣掉之前退过的' }) refundableCents: number;
  @ApiProperty({ description: '可以包换' }) canReplace: boolean;
}

interface WarrantyOrder {
  id: string;
  no: number;
  status: string;
  withWarranty: boolean;
  warrantyCents: number;
  paidCents: number;
  refundedCents: number;
  periodStartAt: Date | null;
  periodEndAt: Date | null;
  /** 已出账、且勾了「退款后终止服务」的退款 */
  refunds?: { id: string }[];
}

export const warrantyOrderSelect = {
  id: true,
  no: true,
  status: true,
  withWarranty: true,
  warrantyCents: true,
  paidCents: true,
  refundedCents: true,
  periodStartAt: true,
  periodEndAt: true,
  refunds: { where: { status: 'PAID', terminate: true }, select: { id: true }, take: 1 },
} as const;

export function faultLabel(fault: string | null): string | null {
  if (!fault) return null;
  return CUSTOMER_FAULTS.find((f) => f.value === fault)?.label ?? fault;
}

/**
 * 质保规则：加购了质保的订单，在它的服务期内包换 + 按天退款（质保费不退）。
 * 不在质保内：没买质保、客户自身原因（违规、自行改密码 / 绑卡）、已过服务期、已退款终止。
 */
export function evaluateWarranty(
  order: WarrantyOrder | null,
  at: Date,
  customerFault: string | null,
): WarrantyDto {
  const base: WarrantyDto = {
    covered: false,
    summary: '',
    reason: null,
    order: order ? { id: order.id, code: displayNo('D', order.no) } : null,
    withWarranty: order?.withWarranty ?? false,
    warrantyCents: order?.warrantyCents ?? 0,
    periodStartAt: order?.periodStartAt ?? null,
    periodEndAt: order?.periodEndAt ?? null,
    totalDays: 0,
    remainingDays: 0,
    planPaidCents: order ? Math.max(0, order.paidCents - order.warrantyCents) : 0,
    refundableCents: 0,
    canReplace: false,
  };
  const notCovered = (reason: string): WarrantyDto => ({
    ...base,
    reason,
    summary: `不在质保内：${reason}`,
  });
  if (!order) return notCovered('找不到对应的已完成订单');
  if (order.refunds?.length) return notCovered('已退款并终止服务');
  if (!order.withWarranty) return notCovered('这笔订单没有购买质保');
  const fault = faultLabel(customerFault);
  if (fault) return notCovered(fault);
  if (!order.periodStartAt || !order.periodEndAt) return notCovered('订单没有服务期记录');
  if (at.getTime() >= order.periodEndAt.getTime()) return notCovered('已过服务期');
  const r = proratedRefund({
    planPaidCents: base.planPaidCents,
    periodStartAt: order.periodStartAt,
    periodEndAt: order.periodEndAt,
    at,
    refundedCents: order.refundedCents,
  });
  return {
    ...base,
    covered: true,
    canReplace: true,
    totalDays: r.totalDays,
    remainingDays: r.remainingDays,
    refundableCents: r.amountCents,
    summary: `可包换 · 可退 ${formatCents(r.amountCents)}（剩余 ${r.remainingDays}/${r.totalDays} 天）`,
  };
}

/** 读出订单再判断质保 */
export async function loadWarranty(
  db: Tx | PrismaService,
  orderId: string | null,
  at: Date,
  customerFault: string | null,
): Promise<WarrantyDto> {
  const order = orderId
    ? await db.order.findUnique({ where: { id: orderId }, select: warrantyOrderSelect })
    : null;
  return evaluateWarranty(order, at, customerFault);
}
