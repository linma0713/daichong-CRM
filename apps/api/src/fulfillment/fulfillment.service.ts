import { Injectable } from '@nestjs/common';
import {
  Prisma,
  type FulfillmentTask,
  type Order,
  type Subscription,
  type TaskType,
} from '@prisma/client';
import { ALL_PERMISSIONS, displayNo, TASK_TYPE_LABELS, termLabel } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings';
import { CommissionEngine } from '../commissions/engine';
import { NotifyService } from '../notify/notify';
import { addHours, addMonths, localDateTimeText, maxDate } from '../common/dates';

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
    private readonly commissions: CommissionEngine,
    private readonly notify: NotifyService,
  ) {}

  /** 能接开通任务的充值员（在职、有「处理开通任务」权限；管理员不参与自动派单） */
  private fulfillers(tx: Tx, extra: Prisma.UserWhereInput = {}) {
    return tx.user.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        roles: { some: { role: { permissions: { has: 'fulfillment:handle' } } } },
        NOT: { roles: { some: { role: { permissions: { has: ALL_PERMISSIONS } } } } },
        ...extra,
      },
      select: { id: true, onDuty: true, lastAssignedAt: true, createdAt: true },
    });
  }

  /**
   * 派单：有人在班就只在「在班」的充值员里派，没人在班时在所有充值员里派；
   * 选手上未完成任务最少的人，一样多时轮流（最久没派到的先派）。
   * 一个充值员都没有时留空，进任务池，谁有空谁领。
   */
  async pickAssignee(tx: Tx, opts: { exclude?: string; onDutyOnly?: boolean } = {}) {
    let candidates = await this.fulfillers(tx, opts.exclude ? { id: { not: opts.exclude } } : {});
    const onDuty = candidates.filter((c) => c.onDuty);
    if (onDuty.length > 0 || opts.onDutyOnly) candidates = onDuty;
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
    const time = (d: Date | null) => d?.getTime() ?? 0;
    const [best] = [...candidates].sort(
      (a, b) =>
        (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) ||
        time(a.lastAssignedAt) - time(b.lastAssignedAt) ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
    await tx.user.update({ where: { id: best.id }, data: { lastAssignedAt: new Date() } });
    return best.id;
  }

  /** 任务的通知文字：标题、正文、链接 */
  async describeTask(
    tx: Tx,
    task: Pick<
      FulfillmentTask,
      'no' | 'type' | 'customerId' | 'orderId' | 'subscriptionId' | 'dueAt' | 'note'
    >,
  ): Promise<{ title: string; body: string; link: string; orderOwnerId: string | null }> {
    const [customer, order] = await Promise.all([
      tx.customer.findUniqueOrThrow({
        where: { id: task.customerId },
        select: { no: true, name: true, ownerId: true },
      }),
      task.orderId
        ? tx.order.findUnique({
            where: { id: task.orderId },
            select: {
              id: true,
              no: true,
              planName: true,
              termMonths: true,
              fulfillmentType: true,
              ownerId: true,
            },
          })
        : null,
    ]);
    const parts = [`客户：${customer.name}（${displayNo('C', customer.no)}）`];
    if (order) {
      parts.push(
        `订单：${displayNo('D', order.no)} · ${order.planName} ${termLabel(order.termMonths)}（${order.fulfillmentType === 'ACCOUNT' ? '成品号' : '代充'}）`,
      );
    }
    parts.push(`截止：${localDateTimeText(task.dueAt)}`);
    const code = displayNo('T', task.no);
    return {
      title: `${code} ${TASK_TYPE_LABELS[task.type]}`,
      body: parts.join('\n'),
      link: `/tasks?view=open&keyword=${code}`,
      orderOwnerId: order?.ownerId ?? customer.ownerId,
    };
  }

  /** 新任务通知：派给了谁就通知谁，进了任务池就通知所有充值员 */
  async notifyCreated(tx: Tx, task: FulfillmentTask): Promise<void> {
    const d = await this.describeTask(tx, task);
    await this.notify.emit(tx, {
      event: 'task.created',
      title: `新任务 ${d.title}`,
      body: task.assigneeId ? d.body : `${d.body}\n还没有人接，请在任务池里领取`,
      link: d.link,
      to: task.assigneeId ? [task.assigneeId] : (await this.fulfillers(tx)).map((u) => u.id),
      toPermission: 'fulfillment:handle',
    });
  }

  /**
   * 上班 / 下班：
   * - 上班：任务池里还没人接的任务按规则派出去（包括派给自己）
   * - 下班：自己手上还没开始的任务转给其他在班的人；没人在班就放回任务池。处理中的任务不动
   */
  async setDuty(userId: string, onDuty: boolean): Promise<{ moved: number }> {
    return this.prisma.$transaction(async (tx) => {
      // 同一时间只处理一个人的上下班，避免两个人同时下班时互相转来转去
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(20261121)`;
      await tx.user.update({
        where: { id: userId },
        data: { onDuty, onDutyChangedAt: new Date() },
      });
      const tasks = await tx.fulfillmentTask.findMany({
        where: onDuty
          ? { status: 'PENDING', assigneeId: null }
          : { status: 'PENDING', assigneeId: userId },
        orderBy: { dueAt: 'asc' },
      });
      let moved = 0;
      for (const task of tasks) {
        const assigneeId = onDuty
          ? await this.pickAssignee(tx)
          : await this.pickAssignee(tx, { exclude: userId, onDutyOnly: true });
        if (assigneeId === task.assigneeId) continue;
        const updated = await tx.fulfillmentTask.update({
          where: { id: task.id },
          data: { assigneeId },
        });
        moved++;
        if (assigneeId && assigneeId !== userId) {
          const d = await this.describeTask(tx, updated);
          await this.notify.emit(tx, {
            event: 'task.assigned',
            title: `转给你的任务 ${d.title}`,
            body: d.body,
            link: d.link,
            to: [assigneeId],
          });
        }
      }
      return { moved };
    });
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
      ticketId?: string;
      dedupeKey?: string;
      note?: string;
    },
  ): Promise<FulfillmentTask | null> {
    if (data.dedupeKey) {
      const exists = await tx.fulfillmentTask.findUnique({ where: { dedupeKey: data.dedupeKey } });
      if (exists) return null;
    }
    const task = await tx.fulfillmentTask.create({
      data: { ...data, assigneeId: await this.pickAssignee(tx) },
    });
    await this.notifyCreated(tx, task);
    return task;
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
    const periodStart = maxDate(sub.endAt, now);
    const newEnd = addMonths(periodStart, order.termMonths);
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
      data: {
        status: 'COMPLETED',
        completedAt: now,
        periodStartAt: periodStart,
        periodEndAt: newEnd,
      },
    });
    await this.commissions.accrue(tx, order.id, now);
    return updated;
  }
}
