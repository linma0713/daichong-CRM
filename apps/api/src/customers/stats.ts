import { Global, Injectable, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NEW_CUSTOMER_DAYS } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { addDays } from '../common/dates';

type Db = Prisma.TransactionClient | PrismaService;

/** 业务设置里「召回期」的键，和 SettingsService 保持一致（这里直接读，避免模块互相依赖） */
const RECALL_WINDOW_KEY = 'recallWindowDays';
const DEFAULT_RECALL_DAYS = 30;

/**
 * 客户分层与价值：按订单和订阅算出阶段、累计实付、首末次付款、服务结束时间。
 *
 * 阶段规则：
 * - 没有收齐过款 → 潜在
 * - 有服务中的订阅，或有已收款正在开通 / 续费的订单 → 第一次付款在 30 天内为新客，否则活跃
 * - 都没有 → 看服务结束时间（没有订阅的按最近一次付款时间）：召回期内为沉睡，超过为流失
 *
 * 流失原因：记录之后客户又付了款（最近收齐款时间晚于记录时间）就自动清掉。
 *
 * 刷新时机：API 启动时、每小时巡检时刷新全部客户；收款、开通 / 续费完成、退款、改订阅后刷新相关客户。
 * 一条 SQL 算完，几万个客户也只要几百毫秒。
 */
@Injectable()
export class CustomerStatsService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CustomerStatsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    try {
      const changed = await this.refresh(this.prisma);
      if (changed > 0) this.logger.log(`客户分层已刷新：${changed} 位客户的阶段有变化`);
    } catch (err) {
      this.logger.error(`刷新客户分层失败：${(err as Error).message}`, (err as Error).stack);
    }
  }

  /**
   * 重新计算客户的分层和价值字段。customerIds 不传 = 全部客户。
   * 返回阶段发生变化的客户数。
   */
  async refresh(db: Db, customerIds?: string[], now = new Date()): Promise<number> {
    if (customerIds && customerIds.length === 0) return 0;
    const row = await db.setting.findUnique({ where: { key: RECALL_WINDOW_KEY } });
    const recallDays = typeof row?.value === 'number' ? row.value : DEFAULT_RECALL_DAYS;
    const newSince = addDays(now, -NEW_CUSTOMER_DAYS);
    const recallSince = addDays(now, -recallDays);
    const only = customerIds
      ? Prisma.sql`AND c.id IN (${Prisma.join([...new Set(customerIds)])})`
      : Prisma.empty;
    const rows = await db.$queryRaw<{ changed: boolean }[]>`
      WITH paid AS (
        SELECT o."customerId",
               MIN(o."paidAt") AS first_paid,
               MAX(o."paidAt") AS last_paid,
               COUNT(o."paidAt")::int AS paid_orders,
               COALESCE(SUM(o."paidCents" - o."refundedCents"), 0)::int AS net,
               BOOL_OR(o.status = 'FULFILLING') AS fulfilling
        FROM "Order" o
        GROUP BY o."customerId"
      ),
      subs AS (
        SELECT s."customerId",
               BOOL_OR(s.status = 'ACTIVE') AS has_active,
               MAX(CASE WHEN s.status = 'CANCELLED' THEN LEAST(s."endAt", s."updatedAt")
                        ELSE s."endAt" END) AS service_end
        FROM "Subscription" s
        GROUP BY s."customerId"
      ),
      calc AS (
        SELECT c.id,
               c.stage AS old_stage,
               p.first_paid,
               p.last_paid,
               COALESCE(p.paid_orders, 0) AS paid_orders,
               COALESCE(p.net, 0) AS net,
               s.service_end,
               CASE
                 WHEN p.first_paid IS NULL THEN 'LEAD'
                 WHEN COALESCE(s.has_active, false) OR COALESCE(p.fulfilling, false) THEN
                   CASE WHEN p.first_paid >= ${newSince} THEN 'NEW' ELSE 'ACTIVE' END
                 WHEN COALESCE(s.service_end, p.last_paid) >= ${recallSince} THEN 'DORMANT'
                 ELSE 'CHURNED'
               END AS stage,
               (c."lostReasonAt" IS NOT NULL AND p.last_paid > c."lostReasonAt") AS clear_lost
        FROM "Customer" c
        LEFT JOIN paid p ON p."customerId" = c.id
        LEFT JOIN subs s ON s."customerId" = c.id
        WHERE c."deletedAt" IS NULL ${only}
      )
      UPDATE "Customer" c SET
        "stage" = calc.stage,
        "stageChangedAt" = CASE WHEN calc.old_stage <> calc.stage THEN ${now}
                                ELSE c."stageChangedAt" END,
        "firstPaidAt" = calc.first_paid,
        "lastPaidAt" = calc.last_paid,
        "paidOrderCount" = calc.paid_orders,
        "netPaidCents" = calc.net,
        "serviceEndAt" = calc.service_end,
        "lostReason" = CASE WHEN calc.clear_lost THEN NULL ELSE c."lostReason" END,
        "lostNote" = CASE WHEN calc.clear_lost THEN NULL ELSE c."lostNote" END,
        "lostReasonAt" = CASE WHEN calc.clear_lost THEN NULL ELSE c."lostReasonAt" END
      FROM calc
      WHERE c.id = calc.id
        AND (calc.old_stage <> calc.stage
          OR c."firstPaidAt" IS DISTINCT FROM calc.first_paid
          OR c."lastPaidAt" IS DISTINCT FROM calc.last_paid
          OR c."paidOrderCount" <> calc.paid_orders
          OR c."netPaidCents" <> calc.net
          OR c."serviceEndAt" IS DISTINCT FROM calc.service_end
          OR calc.clear_lost)
      RETURNING (calc.old_stage <> calc.stage) AS changed`;
    return rows.filter((r) => r.changed).length;
  }
}

@Global()
@Module({
  providers: [CustomerStatsService],
  exports: [CustomerStatsService],
})
export class CustomerStatsModule {}
