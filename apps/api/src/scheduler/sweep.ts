import { Controller, HttpCode, Injectable, Logger, Module, Post } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { Audit, RequirePermissions } from '../auth/decorators';
import { addDays, localDateKey, maxDate } from '../common/dates';
import { SettingsModule, SettingsService } from '../settings/settings';
import { FulfillmentModule } from '../fulfillment/fulfillment.module';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { AftersalesModule, TicketsService } from '../aftersales/aftersales';

/** 多个实例同时巡检时只让一个跑（PostgreSQL 事务级咨询锁） */
const SWEEP_LOCK_ID = 20261120;

export class SweepResultDto {
  @ApiProperty({ description: '另一个巡检正在运行，这次跳过' }) skipped: boolean;
  @ApiProperty({ description: '标记为已到期的订阅数' }) expired: number;
  @ApiProperty({ description: '新建的「回收成品号」任务数' }) reclaimTasks: number;
  @ApiProperty({ description: '新建的「内部续费」任务数' }) internalRenewTasks: number;
  @ApiProperty({ description: '新建的「取消自动续订」任务数' }) cancelAutoRenewTasks: number;
  @ApiProperty({ description: '超时升级的售后工单数' }) escalatedTickets: number;
  @ApiProperty({ description: '自动关闭的售后工单数' }) closedTickets: number;
}

/**
 * 到期风控巡检，每小时跑一次：
 * 1. 服务期结束的订阅标记为「已到期」；成品号到期且没有已付款的续费 → 回收成品号任务（宽限 1 天）
 * 2. 上游快要扣费（提前 N 天，见业务设置）的订阅：
 *    - 客户付费的服务期还覆盖下一次扣费（季付 / 年付中间月）→ 内部续费任务，确保扣费成功
 *    - 服务期不再覆盖、也没有已付款的续费 → 取消自动续订任务，避免替客户垫付下个月
 * 3. 售后工单：超过处理时限的升级，已解决超过设置小时数的自动关闭
 * 任务带去重键（订阅 + 对应日期），重复跑不会重复建。
 */
@Injectable()
export class SweepService {
  private readonly logger = new Logger(SweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly fulfillment: FulfillmentService,
    private readonly tickets: TicketsService,
  ) {}

  @Cron('5 * * * *', {
    name: 'subscription-sweep',
    waitForCompletion: true,
    disabled: process.env.NODE_ENV === 'test',
  })
  async scheduled(): Promise<void> {
    try {
      const r = await this.run();
      const changed =
        r.expired +
        r.reclaimTasks +
        r.internalRenewTasks +
        r.cancelAutoRenewTasks +
        r.escalatedTickets +
        r.closedTickets;
      if (changed > 0) {
        this.logger.log(
          `巡检完成：到期 ${r.expired}，回收 ${r.reclaimTasks}，内部续费 ${r.internalRenewTasks}，取消自动续订 ${r.cancelAutoRenewTasks}，工单升级 ${r.escalatedTickets}，工单自动关闭 ${r.closedTickets}`,
        );
      }
    } catch (err) {
      this.logger.error(`巡检失败：${(err as Error).message}`, (err as Error).stack);
    }
  }

  async run(now = new Date()): Promise<SweepResultDto> {
    const { upstreamLeadDays } = await this.settings.getAll();
    return this.prisma.$transaction(
      async (tx) => {
        const result: SweepResultDto = {
          skipped: false,
          expired: 0,
          reclaimTasks: 0,
          internalRenewTasks: 0,
          cancelAutoRenewTasks: 0,
          escalatedTickets: 0,
          closedTickets: 0,
        };
        const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(${SWEEP_LOCK_ID}) AS locked`;
        if (!locked) return { ...result, skipped: true };

        const hasPaidRenewal = async (subscriptionId: string) =>
          !!(await tx.order.findFirst({
            where: { subscriptionId, kind: 'RENEWAL', status: 'FULFILLING' },
            select: { id: true },
          }));

        // 1. 到期
        const ended = await tx.subscription.findMany({
          where: { status: 'ACTIVE', endAt: { lte: now } },
        });
        for (const sub of ended) {
          await tx.subscription.update({ where: { id: sub.id }, data: { status: 'EXPIRED' } });
          result.expired++;
          if (sub.fulfillmentType !== 'ACCOUNT' || (await hasPaidRenewal(sub.id))) continue;
          const task = await this.fulfillment.createTask(tx, {
            type: 'RECLAIM_ACCOUNT',
            customerId: sub.customerId,
            subscriptionId: sub.id,
            dueAt: maxDate(now, addDays(sub.endAt, 1)),
            dedupeKey: `RECLAIM_ACCOUNT:${sub.id}:${localDateKey(sub.endAt)}`,
          });
          if (task) result.reclaimTasks++;
        }

        // 2. 上游即将扣费
        const upcoming = await tx.subscription.findMany({
          where: {
            autoRenewOn: true,
            status: { in: ['ACTIVE', 'EXPIRED'] },
            upstreamRenewAt: { not: null, lte: addDays(now, upstreamLeadDays) },
          },
        });
        for (const sub of upcoming) {
          const chargeAt = sub.upstreamRenewAt!;
          // 服务期至少比扣费时间多 1 天才算覆盖，避免为了几个小时替客户付整月
          const covered =
            sub.status === 'ACTIVE' && sub.endAt.getTime() > addDays(chargeAt, 1).getTime();
          if (covered) {
            const task = await this.fulfillment.createTask(tx, {
              type: 'INTERNAL_RENEW',
              customerId: sub.customerId,
              subscriptionId: sub.id,
              dueAt: chargeAt,
              dedupeKey: `INTERNAL_RENEW:${sub.id}:${localDateKey(chargeAt)}`,
            });
            if (task) result.internalRenewTasks++;
            continue;
          }
          if (await hasPaidRenewal(sub.id)) continue;
          const task = await this.fulfillment.createTask(tx, {
            type: 'CANCEL_AUTO_RENEW',
            customerId: sub.customerId,
            subscriptionId: sub.id,
            // 最晚在扣费前 1 天取消
            dueAt: maxDate(now, addDays(chargeAt, -1)),
            dedupeKey: `CANCEL_AUTO_RENEW:${sub.id}:${localDateKey(chargeAt)}`,
          });
          if (task) result.cancelAutoRenewTasks++;
        }

        // 3. 售后工单
        const t = await this.tickets.sweep(tx, now);
        result.escalatedTickets = t.escalated;
        result.closedTickets = t.closed;
        return result;
      },
      { timeout: 60_000 },
    );
  }
}

@ApiTags('业务设置')
@ApiBearerAuth()
@Controller('jobs')
export class JobsController {
  constructor(private readonly sweep: SweepService) {}

  @Post('sweep')
  @HttpCode(200)
  @RequirePermissions('settings:write')
  @Audit('job.sweep', '手动运行到期巡检')
  @ApiOperation({ summary: '立即运行一次到期巡检（平时每小时自动运行）' })
  @ApiOkResponse({ type: SweepResultDto })
  run(): Promise<SweepResultDto> {
    return this.sweep.run();
  }
}

@Module({
  imports: [SettingsModule, FulfillmentModule, AftersalesModule],
  providers: [SweepService],
  controllers: [JobsController],
  exports: [SweepService],
})
export class SchedulerModule {}
