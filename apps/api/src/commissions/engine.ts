import { Injectable } from '@nestjs/common';
import type { CommissionRole, CommissionStatus, Prisma } from '@prisma/client';
import { commissionOf, splitCents } from '@crm/shared';
import { addDays, addMonths } from '../common/dates';
import { SettingsService } from '../settings/settings';

type Tx = Prisma.TransactionClient;

/** 计算扣减用到的佣金字段 */
export interface ReducibleRow {
  id: string;
  kind: 'ACCRUAL' | 'CLAWBACK';
  status: CommissionStatus;
  originalCents: number;
  amountCents: number;
  releaseAt: Date;
}

export interface ReductionPlan {
  /** 要扣减的总额（分） */
  totalCents: number;
  /** 直接改金额的佣金：扣到 0 的作废 */
  updates: { id: string; amountCents: number; status: CommissionStatus }[];
  /** 已对账 / 已发放的部分扣不动，记一条扣回（正数，记账时取负） */
  clawbackCents: number;
}

/**
 * 退款后某个代理在这笔订单上的佣金要扣到多少：按「累计退款 / 佣金基数」等比例扣。
 * 先扣冻结中的（越晚解冻的越先扣），再扣可结算的，还不够就记扣回，下次对账抵扣。
 * 按累计退款算目标值，重复调用结果不变。
 */
export function planReduction(
  rows: ReducibleRow[],
  refundedCents: number,
  baseCents: number,
): ReductionPlan {
  const original = rows
    .filter((r) => r.kind === 'ACCRUAL')
    .reduce((sum, r) => sum + r.originalCents, 0);
  const ratio = baseCents > 0 ? Math.min(1, Math.max(0, refundedCents / baseCents)) : 0;
  const target = original - Math.round(original * ratio);
  const current = rows.filter((r) => r.status !== 'VOID').reduce((s, r) => s + r.amountCents, 0);
  let left = current - target;
  const plan: ReductionPlan = { totalCents: Math.max(0, left), updates: [], clawbackCents: 0 };
  if (left <= 0) return plan;
  for (const status of ['FROZEN', 'RELEASABLE'] as const) {
    const candidates = rows
      .filter((r) => r.kind === 'ACCRUAL' && r.status === status && r.amountCents > 0)
      .sort((a, b) => b.releaseAt.getTime() - a.releaseAt.getTime());
    for (const r of candidates) {
      if (left <= 0) break;
      const cut = Math.min(left, r.amountCents);
      const amountCents = r.amountCents - cut;
      plan.updates.push({ id: r.id, amountCents, status: amountCents === 0 ? 'VOID' : r.status });
      left -= cut;
    }
  }
  plan.clawbackCents = Math.max(0, left);
  return plan;
}

/**
 * 佣金引擎：订单完成时计提、退款时扣减、到期解冻。
 * 订单完成、退款出账、到期巡检都调用这里，保证只有一套规则。
 */
@Injectable()
export class CommissionEngine {
  constructor(private readonly settings: SettingsService) {}

  /**
   * 订单完成时计提：没加购质保的一条，完成后冻结 N 天；加购质保的按服务月拆成多期，
   * 服务满一个月释放一期（质保期内退款直接扣还没释放的）。同一订单只计提一次。
   */
  async accrue(tx: Tx, orderId: string, now = new Date()): Promise<void> {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (!order.agentId || order.commissionBaseCents <= 0) return;
    const accrued = await tx.commission.count({ where: { orderId, kind: 'ACCRUAL' } });
    if (accrued > 0) return;
    const { commissionFreezeDays } = await this.settings.getAll();
    const completedAt = order.completedAt ?? now;
    const releaseAts = order.withWarranty
      ? Array.from({ length: Math.max(1, order.termMonths) }, (_, i) =>
          addMonths(order.periodStartAt ?? completedAt, i + 1),
        )
      : [addDays(completedAt, commissionFreezeDays)];
    const bases = splitCents(order.commissionBaseCents, releaseAts.length);
    const roles: [CommissionRole, string | null, number][] = [
      ['DIRECT', order.agentId, order.agentRateBp],
      ['PARENT', order.parentAgentId, order.parentRateBp],
    ];
    for (const [role, agentId, rateBp] of roles) {
      const total = commissionOf(order.commissionBaseCents, rateBp);
      if (!agentId || total <= 0) continue;
      const amounts = splitCents(total, releaseAts.length);
      await tx.commission.createMany({
        data: releaseAts.map((releaseAt, i) => {
          const released = releaseAt.getTime() <= now.getTime();
          return {
            orderId,
            agentId,
            role,
            kind: 'ACCRUAL' as const,
            seq: i + 1,
            rateBp,
            baseCents: bases[i],
            originalCents: amounts[i],
            amountCents: amounts[i],
            status: released ? ('RELEASABLE' as const) : ('FROZEN' as const),
            releaseAt,
            releasedAt: released ? now : null,
          };
        }),
      });
    }
    // 完成前已经有过部分退款的，按退款占比扣掉
    await this.reduceForRefund(tx, orderId, null, now);
  }

  /**
   * 退款出账后扣减佣金（订单的累计退款已经更新）。返回这次扣减的金额（分）。
   * 没计提过佣金的订单（还没完成）先不扣，完成计提时会按累计退款一起扣。
   */
  async reduceForRefund(
    tx: Tx,
    orderId: string,
    refundId: string | null,
    now = new Date(),
  ): Promise<number> {
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    // 锁住这单的佣金行，避免和对账单确认 / 作废同时改状态
    await tx.$queryRaw`SELECT id FROM "Commission" WHERE "orderId" = ${orderId} FOR UPDATE`;
    const rows = await tx.commission.findMany({ where: { orderId } });
    if (rows.length === 0) return 0;
    let reduced = 0;
    for (const role of ['DIRECT', 'PARENT'] as const) {
      const mine = rows.filter((r) => r.role === role);
      if (mine.length === 0) continue;
      const plan = planReduction(mine, order.refundedCents, order.commissionBaseCents);
      if (plan.totalCents === 0) continue;
      reduced += plan.totalCents;
      for (const u of plan.updates) {
        await tx.commission.update({
          where: { id: u.id },
          data: { amountCents: u.amountCents, status: u.status, refundId },
        });
      }
      if (plan.clawbackCents > 0) {
        const first = mine[0];
        await tx.commission.create({
          data: {
            orderId,
            agentId: first.agentId,
            role,
            kind: 'CLAWBACK',
            seq: 0,
            rateBp: first.rateBp,
            baseCents: 0,
            originalCents: -plan.clawbackCents,
            amountCents: -plan.clawbackCents,
            status: 'RELEASABLE',
            releaseAt: now,
            releasedAt: now,
            refundId,
          },
        });
      }
    }
    if (refundId && reduced > 0) {
      await tx.refund.update({
        where: { id: refundId },
        data: { commissionReducedCents: { increment: reduced } },
      });
    }
    await this.syncOrderTotal(tx, orderId);
    return reduced;
  }

  /** 到解冻时间的佣金变成可结算 */
  async release(tx: Tx | Prisma.TransactionClient, now = new Date()): Promise<number> {
    const res = await tx.commission.updateMany({
      where: { status: 'FROZEN', releaseAt: { lte: now } },
      data: { status: 'RELEASABLE', releasedAt: now },
    });
    return res.count;
  }

  /** 订单上的佣金合计（不含已作废），用于每单毛利 */
  async syncOrderTotal(tx: Tx, orderId: string): Promise<void> {
    const sum = await tx.commission.aggregate({
      where: { orderId, status: { not: 'VOID' } },
      _sum: { amountCents: true },
    });
    await tx.order.update({
      where: { id: orderId },
      data: { commissionCents: sum._sum.amountCents ?? 0 },
    });
  }
}
