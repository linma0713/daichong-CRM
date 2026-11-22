import { Injectable, Module } from '@nestjs/common';
import type { CostKind, PaymentResource, ResourceTransaction } from '@prisma/client';
import { feeOf } from '@crm/shared';
import { badRequest, notFound } from '../common/errors';
import type { Tx } from '../fulfillment/fulfillment.service';
import type { PrismaService } from '../prisma/prisma.service';

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** 按当前余额的加权平均成本，算出扣掉 usdCents 对应的人民币成本 */
export function averageCost(
  r: Pick<PaymentResource, 'balanceUsdCents' | 'costPoolCents'>,
  usdCents: number,
): number {
  if (r.balanceUsdCents <= 0 || usdCents <= 0) return 0;
  if (usdCents >= r.balanceUsdCents) return r.costPoolCents;
  return Math.round((r.costPoolCents * usdCents) / r.balanceUsdCents);
}

/**
 * 某个时间点的上游扣费 / 售后问题归哪笔订单：服务期覆盖这个时间点的已完成订单；
 * 找不到（例如 M1 时期的老订单没有服务期）就归最近一笔已完成订单。
 */
export async function orderForPeriod(
  tx: Tx | PrismaService,
  subscriptionId: string,
  at: Date,
): Promise<string | null> {
  const covering = await tx.order.findFirst({
    where: {
      subscriptionId,
      status: 'COMPLETED',
      periodStartAt: { lte: at },
      periodEndAt: { gt: at },
    },
    orderBy: { periodStartAt: 'desc' },
    select: { id: true },
  });
  if (covering) return covering.id;
  const latest = await tx.order.findFirst({
    where: { subscriptionId, status: 'COMPLETED' },
    orderBy: { completedAt: 'desc' },
    select: { id: true },
  });
  return latest?.id ?? null;
}

export interface ConsumeResult {
  tx: ResourceTransaction;
  /** 实际扣掉的美元（含手续费，美分） */
  totalUsdCents: number;
  /** 结转的人民币成本（分） */
  costCents: number;
}

/**
 * 库存与成本记账：付款资源的入库、扣费、盘点，以及把成本记到订单上。
 * 都在调用方的事务里执行，和订单 / 任务的状态变化同时成功或同时失败。
 */
@Injectable()
export class LedgerService {
  /** 锁住付款资源行，避免两笔扣费同时改余额 */
  async lockResource(tx: Tx, id: string): Promise<PaymentResource> {
    await tx.$queryRaw`SELECT id FROM "PaymentResource" WHERE id = ${id} FOR UPDATE`;
    const r = await tx.paymentResource.findUnique({ where: { id } });
    if (!r) throw notFound('付款资源');
    return r;
  }

  /** 入库 / 充值：美元余额增加，人民币成本按实际花费入池 */
  async topUp(
    tx: Tx,
    resourceId: string,
    data: { usdCents: number; cnyCents: number; note?: string; userId: string },
  ): Promise<ResourceTransaction> {
    const r = await this.lockResource(tx, resourceId);
    const balance = r.balanceUsdCents + data.usdCents;
    await tx.paymentResource.update({
      where: { id: r.id },
      data: { balanceUsdCents: balance, costPoolCents: r.costPoolCents + data.cnyCents },
    });
    return tx.resourceTransaction.create({
      data: {
        resourceId: r.id,
        type: 'TOP_UP',
        usdCents: data.usdCents,
        cnyCents: data.cnyCents,
        balanceAfterUsdCents: balance,
        note: data.note?.trim() || null,
        userId: data.userId,
      },
    });
  }

  /**
   * 上游扣费：按资源的手续费规则加上手续费，从余额里扣，并按平均成本结转人民币成本。
   * 余额不够时拒绝，提示先入库或盘点（账面余额要和实际一致，毛利才准）。
   */
  async consume(
    tx: Tx,
    resourceId: string,
    data: { usdCents: number; note?: string; userId: string; accountId?: string },
  ): Promise<ConsumeResult> {
    if (data.usdCents <= 0) throw badRequest('扣费金额必须大于 0');
    const r = await this.lockResource(tx, resourceId);
    if (!r.active) throw badRequest(`付款资源「${r.name}」已停用`);
    const totalUsdCents = data.usdCents + feeOf(data.usdCents, r.feeBp, r.feeFixedUsdCents);
    if (totalUsdCents > r.balanceUsdCents) {
      throw badRequest(
        `「${r.name}」余额不足：这次要扣 ${usd(totalUsdCents)}（含手续费），账面只剩 ${usd(r.balanceUsdCents)}。请先在「库存与成本」入库，或按实际余额盘点`,
        'RESOURCE_INSUFFICIENT',
      );
    }
    const costCents = averageCost(r, totalUsdCents);
    const balance = r.balanceUsdCents - totalUsdCents;
    await tx.paymentResource.update({
      where: { id: r.id },
      data: { balanceUsdCents: balance, costPoolCents: r.costPoolCents - costCents },
    });
    const row = await tx.resourceTransaction.create({
      data: {
        resourceId: r.id,
        type: 'CONSUME',
        usdCents: -totalUsdCents,
        cnyCents: -costCents,
        balanceAfterUsdCents: balance,
        note: data.note?.trim() || null,
        accountId: data.accountId ?? null,
        userId: data.userId,
      },
    });
    return { tx: row, totalUsdCents, costCents };
  }

  /**
   * 盘点调整：把账面余额改成实际余额。差额按当前平均成本增减人民币成本，
   * 不改变每美元的平均成本。
   */
  async adjust(
    tx: Tx,
    resourceId: string,
    data: { actualUsdCents: number; note: string; userId: string },
  ): Promise<ResourceTransaction> {
    const r = await this.lockResource(tx, resourceId);
    const delta = data.actualUsdCents - r.balanceUsdCents;
    if (delta === 0) throw badRequest('实际余额和账面一致，不需要调整');
    const cnyDelta =
      delta < 0
        ? -averageCost(r, -delta)
        : r.balanceUsdCents > 0
          ? Math.round((r.costPoolCents * delta) / r.balanceUsdCents)
          : 0;
    await tx.paymentResource.update({
      where: { id: r.id },
      data: { balanceUsdCents: data.actualUsdCents, costPoolCents: r.costPoolCents + cnyDelta },
    });
    return tx.resourceTransaction.create({
      data: {
        resourceId: r.id,
        type: 'ADJUST',
        usdCents: delta,
        cnyCents: cnyDelta,
        balanceAfterUsdCents: data.actualUsdCents,
        note: data.note.trim(),
        userId: data.userId,
      },
    });
  }

  /** 记一笔成本；有订单时同步累加订单的成本合计 */
  async recordCost(
    tx: Tx,
    data: {
      kind: CostKind;
      amountCents: number;
      usdCents?: number;
      orderId?: string | null;
      subscriptionId?: string | null;
      taskId?: string | null;
      accountId?: string | null;
      resourceTxId?: string | null;
      note?: string;
      userId: string;
    },
  ): Promise<void> {
    await tx.costEntry.create({
      data: {
        kind: data.kind,
        amountCents: data.amountCents,
        usdCents: data.usdCents ?? null,
        orderId: data.orderId ?? null,
        subscriptionId: data.subscriptionId ?? null,
        taskId: data.taskId ?? null,
        accountId: data.accountId ?? null,
        resourceTxId: data.resourceTxId ?? null,
        note: data.note ?? null,
        userId: data.userId,
      },
    });
    if (data.orderId && data.amountCents !== 0) {
      await tx.order.update({
        where: { id: data.orderId },
        data: { costCents: { increment: data.amountCents } },
      });
    }
  }

  /** 上游扣费并把成本记到订单上 */
  async chargeUpstream(
    tx: Tx,
    data: {
      resourceId: string;
      usdCents: number;
      orderId: string | null;
      subscriptionId?: string | null;
      taskId?: string | null;
      accountId?: string | null;
      note: string;
      userId: string;
    },
  ): Promise<ConsumeResult> {
    const result = await this.consume(tx, data.resourceId, {
      usdCents: data.usdCents,
      note: data.note,
      userId: data.userId,
    });
    await this.recordCost(tx, {
      kind: 'UPSTREAM_CHARGE',
      amountCents: result.costCents,
      usdCents: result.totalUsdCents,
      orderId: data.orderId,
      subscriptionId: data.subscriptionId,
      taskId: data.taskId,
      accountId: data.accountId,
      resourceTxId: result.tx.id,
      note: data.note,
      userId: data.userId,
    });
    return result;
  }

  /** 见 {@link orderForPeriod} */
  orderForPeriod(tx: Tx, subscriptionId: string, at: Date): Promise<string | null> {
    return orderForPeriod(tx, subscriptionId, at);
  }

  /** 是否已经配置了可用的付款资源（还没配置时不强制登记扣费，方便先用起来） */
  async hasActiveResources(tx: Tx): Promise<boolean> {
    return (await tx.paymentResource.count({ where: { active: true } })) > 0;
  }
}

@Module({ providers: [LedgerService], exports: [LedgerService] })
export class LedgerModule {}
