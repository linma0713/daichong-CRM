import { ApiProperty } from '@nestjs/swagger';
import type { PaymentLink } from '@prisma/client';
import { PAYMENT_LINK_STATUSES, displayNo, type PaymentLinkStatus } from '@crm/shared';
import { UserBriefDto } from '../common/briefs';

/** 订单详情里的收款链接（订单模块和在线收款模块都用，单独放一个文件避免循环引用） */
export class PaymentLinkDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'P00012' }) code: string;
  @ApiProperty({ example: 'mock', description: '收款通道' }) channel: string;
  @ApiProperty() amountCents: number;
  @ApiProperty({ enum: PAYMENT_LINK_STATUSES, enumName: 'PaymentLinkStatus' })
  status: PaymentLinkStatus;
  @ApiProperty({ example: '/pay/xxxx', description: '付款页路径' }) payPath: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '完整的付款链接；没设置 APP_PUBLIC_URL 时为空，前端用当前访问地址拼',
  })
  payUrl: string | null;
  @ApiProperty() expiresAt: Date;
  @ApiProperty({ type: String, nullable: true }) paidAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) closedAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: '到账了但没法自动记收款的原因（要人工核对退款）',
  })
  anomaly: string | null;
  @ApiProperty({ type: UserBriefDto }) createdBy: UserBriefDto;
  @ApiProperty() createdAt: Date;
}

/** 还在等付款但已经过了有效期的，按已过期显示（定时任务每 5 分钟才落库一次） */
export function effectiveLinkStatus(
  link: Pick<PaymentLink, 'status' | 'expiresAt'>,
  now = new Date(),
): PaymentLinkStatus {
  const status = link.status as PaymentLinkStatus;
  return status === 'PENDING' && link.expiresAt <= now ? 'EXPIRED' : status;
}

export function payPathOf(token: string): string {
  return `/pay/${token}`;
}

export function payUrlOf(token: string, publicUrl: string | undefined): string | null {
  return publicUrl ? `${publicUrl.replace(/\/+$/, '')}${payPathOf(token)}` : null;
}

export function toPaymentLinkDto(
  link: PaymentLink & { createdBy: UserBriefDto },
  publicUrl: string | undefined,
): PaymentLinkDto {
  return {
    id: link.id,
    code: displayNo('P', link.no),
    channel: link.channel,
    amountCents: link.amountCents,
    status: effectiveLinkStatus(link),
    payPath: payPathOf(link.token),
    payUrl: payUrlOf(link.token, publicUrl),
    expiresAt: link.expiresAt,
    paidAt: link.paidAt,
    closedAt: link.closedAt,
    anomaly: link.anomaly,
    createdBy: link.createdBy,
    createdAt: link.createdAt,
  };
}
