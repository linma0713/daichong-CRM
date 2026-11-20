import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type FulfillmentTask,
  type Order,
  type Subscription,
  type TaskType,
} from '@prisma/client';
import { ALL_PERMISSIONS } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings';
import { addHours, addMonths, maxDate } from '../common/dates';

export type Tx = Prisma.TransactionClient;

const OPEN_STATUSES = ['PENDING', 'IN_PROGRESS', 'FAILED'] as const;

/**
 * 履约核心：建任务、派单、续费延期。订单收款、任务完成、定时巡检都调用这里，
 * 保证同一件事只有一套规则。
 */
@Injectable()
export class FulfillmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * 派单：在有「处理开通任务」权限的在职员工里，选手上未完成任务最少的人；
   * 没有充值员时留空，进公共任务池，谁有空谁领。管理员不参与自动派单。
   */
  async pickAssignee(tx: Tx): Promise<string | null> {
    const candidates = await tx.user.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        roles: { some: { role: { permissions: { has: 'fulfillment:handle' } } } },
        NOT: { roles: { some: { role: { permissions: { has: ALL_PERMISSIONS } } } } },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (candidates.length === 0) return null;
    const loads = await tx.fulfillmentTask.groupBy({
      by: ['assigneeId'],
      where: {
        assigneeId: { in: candidates.map((c) => c.id) },
        status: { in: ['PENDING', 'IN_PROGRESS'] },
      },
      _count: { _all: true },
    });
    const load = new Map(loads.map((l) => [l.assigneeId, l._count._all]));
    let best = candidates[0].id;
    for (const c of candidates) {
      if ((load.get(c.id) ?? 0) < (load.get(best) ?? 0)) best = c.id;
    }
    return best;
  }

  /** 建任务；带 dedupeKey 的任务已存在时不重复建，返回 null */
  async createTask(
    tx: Tx,
    data: {
      type: TaskType;
      customerId: string;
      dueAt: Date;
      orderId?: string;
      subscriptionId?: string;
      dedupeKey?: string;
      note?: string;
    },
  ): Promise<FulfillmentTask | null> {
    if (data.dedupeKey) {
      const exists = await tx.fulfillmentTask.findUnique({ where: { dedupeKey: data.dedupeKey } });
      if (exists) return null;
    }
    return tx.fulfillmentTask.create({
      data: { ...data, assigneeId: await this.pickAssignee(tx) },
    });
  }

  /**
   * 订单收齐款之后：
   * - 新购：建「新开通」任务
   * - 续费：订阅还在服务中、上游自动续订开着、套餐没变 → 直接延长服务期，不用人工处理；
   *   否则（已到期、已取消或正在取消自动续订、换套餐）建「客户续费」任务
   */
  async onOrderPaid(tx: Tx, order: Order, now = new Date()): Promise<void> {
    const { activateSlaHours } = await this.settings.getAll();
    const dueAt = addHours(now, activateSlaHours);
    if (order.kind === 'NEW') {
      await this.createTask(tx, {
        type: 'ACTIVATE',
        customerId: order.customerId,
        orderId: order.id,
        dueAt,
      });
      return;
    }
    const [sub, product] = await Promise.all([
      tx.subscription.findUniqueOrThrow({ where: { id: order.subscriptionId! } }),
      tx.product.findUniqueOrThrow({ where: { id: order.productId } }),
    ]);
    // 充值员正在取消自动续订时，上游状态说不准，交给人工确认
    const cancelling = await tx.fulfillmentTask.findFirst({
      where: { subscriptionId: sub.id, type: 'CANCEL_AUTO_RENEW', status: 'IN_PROGRESS' },
      select: { id: true },
    });
    const seamless =
      sub.status === 'ACTIVE' && sub.autoRenewOn && product.planId === sub.planId && !cancelling;
    if (seamless) {
      await this.applyRenewal(tx, order, sub, product.planId, {}, now);
      return;
    }
    await this.createTask(tx, {
      type: 'RENEW',
      customerId: order.customerId,
      orderId: order.id,
      subscriptionId: sub.id,
      dueAt,
    });
  }

  /**
   * 续费生效：服务期从「原到期时间」和「现在」中较晚的那个往后延；
   * 之前因为没续费而生成的「取消自动续订 / 回收成品号」任务自动作废。
   */
  async applyRenewal(
    tx: Tx,
    order: Order,
    sub: Subscription,
    planId: string,
    opts: { upstreamRenewAt?: Date },
    now = new Date(),
  ): Promise<Subscription> {
    const newEnd = addMonths(maxDate(sub.endAt, now), order.termMonths);
    const reenable = !sub.autoRenewOn;
    const updated = await tx.subscription.update({
      where: { id: sub.id },
      data: {
        endAt: newEnd,
        status: 'ACTIVE',
        planId,
        ...(reenable
          ? { autoRenewOn: true, upstreamRenewAt: opts.upstreamRenewAt ?? addMonths(now, 1) }
          : opts.upstreamRenewAt
            ? { upstreamRenewAt: opts.upstreamRenewAt }
            : {}),
      },
    });
    await tx.fulfillmentTask.updateMany({
      where: {
        subscriptionId: sub.id,
        type: { in: ['CANCEL_AUTO_RENEW', 'RECLAIM_ACCOUNT'] },
        status: { in: [...OPEN_STATUSES] },
      },
      data: { status: 'CANCELLED', note: '客户已续费，任务自动取消', finishedAt: now },
    });
    await tx.order.update({
      where: { id: order.id },
      data: { status: 'COMPLETED', completedAt: now },
    });
    return updated;
  }
}
