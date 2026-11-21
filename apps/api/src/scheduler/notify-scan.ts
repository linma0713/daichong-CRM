import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ApiProperty } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';
import { formatCents } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings';
import { InventoryService } from '../inventory/inventory';
import { NotifyService } from '../notify/notify';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { addDays, localDateKey, startOfLocalDay } from '../common/dates';

const SCAN_LOCK_ID = 20261121;
const INVENTORY_KEY = 'notifyInventoryLow';
const DIGEST_KEY = 'notifyDigestDate';
/** 超时提醒只管最近几天到期的任务；更早的（例如刚升级上来的老数据）静默标记，免得一下子刷屏 */
const OVERDUE_LOOKBACK_DAYS = 3;
const TZ_OFFSET_MS = 8 * 3600_000;
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export class NotifyScanResultDto {
  @ApiProperty({ description: '另一个实例正在扫描，这次跳过' }) skipped: boolean;
  @ApiProperty({ description: '发出的任务超时提醒' }) overdueTasks: number;
  @ApiProperty({ description: '新出现的库存预警项' }) inventoryAlerts: number;
  @ApiProperty({ description: '是否发了每日早报' }) digestSent: boolean;
}

interface LowState {
  resources: string[];
  plans: string[];
}

/**
 * 消息巡检，每 5 分钟一次：
 * 1. 开通 / 续费任务过了截止时间还没完成 → 提醒负责的充值员（每个任务一次）
 * 2. 付款资源余额、成品号库存跌破预警线 → 提醒管库存的人（同一项恢复之前不重复提醒）
 * 3. 每天到了设置的钟点 → 往订阅了早报的企业微信群推一条汇总
 * 4. 清理：30 天前已发出的群消息、90 天前已读的站内消息
 */
@Injectable()
export class NotifyScanService {
  private readonly logger = new Logger(NotifyScanService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly inventory: InventoryService,
    private readonly notify: NotifyService,
    private readonly fulfillment: FulfillmentService,
  ) {}

  @Cron('*/5 * * * *', {
    name: 'notify-scan',
    waitForCompletion: true,
    disabled: process.env.NODE_ENV === 'test',
  })
  async scheduled(): Promise<void> {
    try {
      await this.run();
    } catch (err) {
      this.logger.error(`消息巡检失败：${(err as Error).message}`, (err as Error).stack);
    }
  }

  async run(now = new Date()): Promise<NotifyScanResultDto> {
    return this.prisma.$transaction(
      async (tx) => {
        const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${SCAN_LOCK_ID}) AS locked`;
        if (!locked) {
          return { skipped: true, overdueTasks: 0, inventoryAlerts: 0, digestSent: false };
        }
        const overdueTasks = await this.overdueTasks(tx, now);
        const inventoryAlerts = await this.inventoryLow(tx);
        const digestSent = await this.digest(tx, now);
        await tx.outboundMessage.deleteMany({
          where: { status: 'SENT', createdAt: { lt: addDays(now, -30) } },
        });
        await tx.notification.deleteMany({
          where: { readAt: { not: null }, createdAt: { lt: addDays(now, -90) } },
        });
        return { skipped: false, overdueTasks, inventoryAlerts, digestSent };
      },
      { timeout: 60_000 },
    );
  }

  private async overdueTasks(tx: Prisma.TransactionClient, now: Date): Promise<number> {
    const open: Prisma.FulfillmentTaskWhereInput = {
      status: { in: ['PENDING', 'IN_PROGRESS'] },
      overdueNotifiedAt: null,
    };
    await tx.fulfillmentTask.updateMany({
      where: { ...open, dueAt: { lt: addDays(now, -OVERDUE_LOOKBACK_DAYS) } },
      data: { overdueNotifiedAt: now },
    });
    const tasks = await tx.fulfillmentTask.findMany({
      where: { ...open, dueAt: { lt: now } },
      include: { assignee: { select: { displayName: true } } },
      orderBy: { dueAt: 'asc' },
      take: 50,
    });
    for (const task of tasks) {
      await tx.fulfillmentTask.update({
        where: { id: task.id },
        data: { overdueNotifiedAt: now },
      });
      const d = await this.fulfillment.describeTask(tx, task);
      await this.notify.emit(tx, {
        event: 'task.overdue',
        title: `${d.title} 已超时`,
        body: `${d.body}\n负责人：${task.assignee?.displayName ?? '还没有人接'}`,
        link: d.link,
        to: [task.assigneeId],
        toPermission: 'fulfillment:handle',
      });
    }
    return tasks.length;
  }

  private async inventoryLow(tx: Prisma.TransactionClient): Promise<number> {
    const summary = await this.inventory.summary();
    const row = await tx.setting.findUnique({ where: { key: INVENTORY_KEY } });
    const before = (row?.value as LowState | undefined) ?? { resources: [], plans: [] };
    const lowPools = summary.pools.filter((p) => p.low);
    const current: LowState = {
      resources: summary.lowResources.map((r) => r.id),
      plans: lowPools.map((p) => p.planId),
    };
    const lines: string[] = [];
    for (const r of summary.lowResources) {
      if (before.resources.includes(r.id)) continue;
      lines.push(
        `付款资源「${r.name}」余额 ${formatCents(r.balanceUsdCents, '$')}，低于预警线 ${formatCents(
          r.lowBalanceUsdCents,
          '$',
        )}`,
      );
    }
    for (const p of lowPools) {
      if (before.plans.includes(p.planId)) continue;
      lines.push(
        `${p.planName} 成品号只剩 ${p.inStock} 个（预警线 ${summary.accountStockLow} 个）`,
      );
    }
    if (lines.length > 0) {
      await this.notify.emit(tx, {
        event: 'inventory.low',
        title: lines.length === 1 ? '库存预警' : `库存预警：${lines.length} 项`,
        body: `${lines.join('\n')}\n请及时充值或补货，以免开通失败`,
        link: '/inventory',
        toPermission: 'inventory:write',
      });
    }
    await tx.setting.upsert({
      where: { key: INVENTORY_KEY },
      create: { key: INVENTORY_KEY, value: current as unknown as Prisma.InputJsonValue },
      update: { value: current as unknown as Prisma.InputJsonValue },
    });
    return lines.length;
  }

  private async digest(tx: Prisma.TransactionClient, now: Date): Promise<boolean> {
    const { dailyDigestHour } = await this.settings.getAll();
    const today = localDateKey(now);
    const hour = new Date(now.getTime() + TZ_OFFSET_MS).getUTCHours();
    if (hour < dailyDigestHour) return false;
    const row = await tx.setting.findUnique({ where: { key: DIGEST_KEY } });
    if (row?.value === today) return false;
    await tx.setting.upsert({
      where: { key: DIGEST_KEY },
      create: { key: DIGEST_KEY, value: today },
      update: { value: today },
    });
    const subscribers = await tx.notifyChannel.count({
      where: { enabled: true, events: { has: 'daily.digest' } },
    });
    if (subscribers === 0) return false;
    const body = await this.digestBody(tx, now);
    const local = new Date(now.getTime() + TZ_OFFSET_MS);
    await this.notify.emit(tx, {
      event: 'daily.digest',
      title: `${local.getUTCMonth() + 1} 月 ${local.getUTCDate()} 日（周${WEEKDAYS[local.getUTCDay()]}）`,
      body,
      link: '/',
      groupOnly: true,
    });
    return true;
  }

  /** 早报内容：昨天的经营数字 + 今天要处理的事 */
  async digestBody(tx: Prisma.TransactionClient, now: Date): Promise<string> {
    const todayStart = startOfLocalDay(now);
    const yesterday = { gte: addDays(todayStart, -1), lt: todayStart };
    const [
      payments,
      refunds,
      newCustomers,
      paidOrders,
      renewals,
      openTasks,
      overdueTasks,
      poolTasks,
      expiring,
      openTickets,
      escalated,
      pendingRefunds,
      summary,
    ] = await Promise.all([
      tx.payment.aggregate({
        where: { receivedAt: yesterday },
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
      tx.refund.aggregate({
        where: { status: 'PAID', paidAt: yesterday },
        _sum: { amountCents: true },
      }),
      tx.customer.count({ where: { deletedAt: null, createdAt: yesterday } }),
      tx.order.count({ where: { paidAt: yesterday } }),
      tx.order.count({ where: { paidAt: yesterday, kind: 'RENEWAL' } }),
      tx.fulfillmentTask.count({ where: { status: { in: ['PENDING', 'IN_PROGRESS'] } } }),
      tx.fulfillmentTask.count({
        where: { status: { in: ['PENDING', 'IN_PROGRESS'] }, dueAt: { lt: now } },
      }),
      tx.fulfillmentTask.count({ where: { status: 'PENDING', assigneeId: null } }),
      tx.subscription.count({
        where: { status: 'ACTIVE', endAt: { gte: now, lt: addDays(todayStart, 8) } },
      }),
      tx.ticket.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER'] } } }),
      tx.ticket.count({
        where: {
          status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER'] },
          escalatedAt: { not: null },
        },
      }),
      tx.refund.count({ where: { status: 'PENDING' } }),
      this.inventory.summary(),
    ]);
    const lines = [
      `昨天收款 ${formatCents(payments._sum.amountCents ?? 0)}（${payments._count._all} 笔），退款 ${formatCents(
        refunds._sum.amountCents ?? 0,
      )}`,
      `昨天新客户 ${newCustomers} 位，收齐款订单 ${paidOrders} 单（其中续费 ${renewals} 单）`,
      `待开通 / 续费任务 ${openTasks} 个${overdueTasks ? `，已超时 ${overdueTasks} 个` : ''}${
        poolTasks ? `，任务池里没人接 ${poolTasks} 个` : ''
      }`,
      `7 天内到期的订阅 ${expiring} 个，记得提醒续费`,
      `未解决的售后工单 ${openTickets} 个${escalated ? `（已升级 ${escalated} 个）` : ''}，退款待审批 ${pendingRefunds} 笔`,
    ];
    const lows = [
      ...summary.lowResources.map((r) => `${r.name} 余额 ${formatCents(r.balanceUsdCents, '$')}`),
      ...summary.pools.filter((p) => p.low).map((p) => `${p.planName} 成品号剩 ${p.inStock} 个`),
    ];
    if (lows.length > 0) lines.push(`库存预警：${lows.join('；')}`);
    return lines.join('\n');
  }
}
