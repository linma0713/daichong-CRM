import {
  Body,
  Controller,
  Delete,
  Get,
  Global,
  HttpCode,
  Injectable,
  Logger,
  Module,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { Prisma } from '@prisma/client';
import {
  ALL_PERMISSIONS,
  NOTIFY_EVENT_LABELS,
  NOTIFY_EVENT_VALUES,
  maskWebhookKey,
  parseWecomWebhook,
  type NotifyEvent,
  type OutboundStatus,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SecretBox } from '../common/secret-box';
import { Audit, CurrentUser, RequirePermissions, SkipAudit } from '../auth/decorators';
import type { AuthUser } from '../common/auth-user';
import { PageQueryDto, skipTake } from '../common/pagination';
import { badRequest, notFound } from '../common/errors';
import { OkDto } from '../auth/auth.dto';

type Db = PrismaService | Prisma.TransactionClient;

// ─────────────── 发通知 ───────────────

export interface NoticeInput {
  event: NotifyEvent;
  /** 站内消息标题，也是群消息的第一行 */
  title: string;
  /** 站内消息正文；群消息里以引用的形式显示 */
  body?: string | null;
  /** 点击后打开的后台页面，例如 /orders/xxx */
  link?: string | null;
  /** 站内收件人；为空时按 toPermission 找人 */
  to?: (string | null | undefined)[];
  /** 拥有这个权限的员工（不含只靠「全部权限」的管理员）；一个都没有就发给管理员 */
  toPermission?: string;
  /** 不发给这个人（通常是操作人自己） */
  except?: string | null;
  /** 只推群，不发站内消息（例如每日早报） */
  groupOnly?: boolean;
}

/** 需要尽快处理的事件，群消息标题用醒目的颜色 */
const URGENT: NotifyEvent[] = [
  'task.overdue',
  'task.failed',
  'ticket.escalated',
  'refund.requested',
  'inventory.low',
];

/** 企业微信 markdown 不能超过 4096 字节 */
const WECOM_MAX_BYTES = 4000;

/** 用户写的文字里去掉会被当成 markdown 标签的尖括号 */
function plain(text: string): string {
  return text.replace(/</g, '＜').replace(/>/g, '＞');
}

export function formatGroupMessage(input: NoticeInput, publicUrl?: string): string {
  const color = URGENT.includes(input.event) ? 'warning' : 'info';
  const lines = [`<font color="${color}">【${NOTIFY_EVENT_LABELS[input.event]}】</font>`];
  lines.push(`**${plain(input.title)}**`);
  for (const line of (input.body ?? '').split('\n').filter(Boolean)) {
    lines.push(`> ${plain(line)}`);
  }
  if (publicUrl && input.link) {
    lines.push(`[在后台打开](${publicUrl.replace(/\/+$/, '')}${input.link})`);
  }
  let content = lines.join('\n');
  while (Buffer.byteLength(content, 'utf8') > WECOM_MAX_BYTES) {
    content = content.slice(0, Math.floor(content.length * 0.9));
  }
  return content;
}

/**
 * 业务事件 → 站内消息 + 企业微信群消息。
 * 传入调用方的事务：业务失败回滚时通知也不会发出；群消息先落库（outbox），后台定时发送，失败自动重试。
 */
@Injectable()
export class NotifyService {
  private readonly publicUrl?: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.publicUrl = config.get<string>('APP_PUBLIC_URL') || undefined;
  }

  async emit(db: Db, input: NoticeInput): Promise<void> {
    if (!input.groupOnly) {
      let to = [...new Set((input.to ?? []).filter((id): id is string => !!id))];
      if (to.length === 0 && input.toPermission) {
        to = await this.holders(db, input.toPermission);
      }
      to = to.filter((id) => id !== input.except);
      if (to.length > 0) {
        await db.notification.createMany({
          data: to.map((userId) => ({
            userId,
            event: input.event,
            title: input.title,
            body: input.body ?? null,
            link: input.link ?? null,
          })),
        });
      }
    }
    const channels = await db.notifyChannel.findMany({
      where: { enabled: true, events: { has: input.event } },
      select: { id: true },
    });
    if (channels.length > 0) {
      const content = formatGroupMessage(input, this.publicUrl);
      await db.outboundMessage.createMany({
        data: channels.map((c) => ({ channelId: c.id, event: input.event, content })),
      });
    }
  }

  /** 拥有某个权限的在职员工；没有人专门负责时交给管理员 */
  async holders(db: Db, permission: string): Promise<string[]> {
    const base = { deletedAt: null, status: 'ACTIVE' as const };
    const explicit = await db.user.findMany({
      where: { ...base, roles: { some: { role: { permissions: { has: permission } } } } },
      select: { id: true },
    });
    if (explicit.length > 0) return explicit.map((u) => u.id);
    const admins = await db.user.findMany({
      where: { ...base, roles: { some: { role: { permissions: { has: ALL_PERMISSIONS } } } } },
      select: { id: true },
    });
    return admins.map((u) => u.id);
  }
}

// ─────────────── 推送到企业微信 ───────────────

/** 调企业微信群机器人接口。WECOM_API_BASE 只在本地联调时用来指向模拟服务 */
@Injectable()
export class WecomSender {
  private readonly base?: string;

  constructor(config: ConfigService) {
    this.base = config.get<string>('WECOM_API_BASE') || undefined;
  }

  async send(webhook: string, content: string): Promise<void> {
    const url = this.base
      ? webhook.replace('https://qyapi.weixin.qq.com', this.base.replace(/\/+$/, ''))
      : webhook;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new Error(`连接企业微信失败：${(err as Error).message}`);
    }
    if (!res.ok) throw new Error(`企业微信返回 HTTP ${res.status}`);
    const data = (await res.json().catch(() => null)) as { errcode?: number; errmsg?: string };
    if (!data || data.errcode !== 0) {
      throw new Error(
        `企业微信返回错误 ${data?.errcode ?? '?'}：${data?.errmsg ?? '无法识别的响应'}`,
      );
    }
  }
}

/** 第 n 次失败后多久重试；超过次数标记为发送失败 */
const RETRY_MINUTES = [1, 5, 30, 120];

@Injectable()
export class NotifyDispatcher {
  private readonly logger = new Logger(NotifyDispatcher.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBox,
    private readonly sender: WecomSender,
  ) {}

  @Interval('notify-deliver', 10_000)
  async scheduled(): Promise<void> {
    if (process.env.NODE_ENV === 'test' || this.running) return;
    this.running = true;
    try {
      await this.deliverDue();
    } catch (err) {
      this.logger.error(`推送群消息失败：${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** 发送到期的群消息，返回发送成功的条数。多个实例同时跑时用 SKIP LOCKED 分开领取 */
  async deliverDue(now = new Date(), limit = 20): Promise<number> {
    const leased = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "OutboundMessage" SET "nextAttemptAt" = ${new Date(now.getTime() + 5 * 60_000)}
      WHERE id IN (
        SELECT id FROM "OutboundMessage"
        WHERE status = 'PENDING' AND "nextAttemptAt" <= ${now}
        ORDER BY "createdAt" LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id`;
    if (leased.length === 0) return 0;
    const messages = await this.prisma.outboundMessage.findMany({
      where: { id: { in: leased.map((m) => m.id) } },
      include: { channel: true },
      orderBy: { createdAt: 'asc' },
    });
    let sent = 0;
    for (const m of messages) {
      if (!m.channel.enabled) {
        await this.prisma.outboundMessage.update({
          where: { id: m.id },
          data: { status: 'FAILED', lastError: '群机器人已停用，没有发送' },
        });
        continue;
      }
      try {
        await this.sender.send(this.secrets.decrypt(m.channel.webhookEnc), m.content);
        await this.prisma.$transaction([
          this.prisma.outboundMessage.update({
            where: { id: m.id },
            data: {
              status: 'SENT',
              sentAt: new Date(),
              attempts: { increment: 1 },
              lastError: null,
            },
          }),
          this.prisma.notifyChannel.update({
            where: { id: m.channelId },
            data: { lastSentAt: new Date(), lastError: null },
          }),
        ]);
        sent++;
      } catch (err) {
        const attempts = m.attempts + 1;
        const error = (err as Error).message.slice(0, 500);
        const retryIn = RETRY_MINUTES[attempts - 1];
        await this.prisma.$transaction([
          this.prisma.outboundMessage.update({
            where: { id: m.id },
            data: {
              attempts,
              lastError: error,
              ...(retryIn === undefined
                ? { status: 'FAILED' }
                : { nextAttemptAt: new Date(now.getTime() + retryIn * 60_000) }),
            },
          }),
          this.prisma.notifyChannel.update({
            where: { id: m.channelId },
            data: { lastError: error },
          }),
        ]);
      }
    }
    return sent;
  }
}

// ─────────────── 站内消息接口 ───────────────

export class NotificationDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: NOTIFY_EVENT_VALUES }) event: string;
  @ApiProperty() title: string;
  @ApiProperty({ type: String, nullable: true }) body: string | null;
  @ApiProperty({ type: String, nullable: true }) link: string | null;
  @ApiProperty({ type: Date, nullable: true }) readAt: Date | null;
  @ApiProperty() createdAt: Date;
}

export class NotificationListDto {
  @ApiProperty({ type: [NotificationDto] }) items: NotificationDto[];
  @ApiProperty() total: number;
  @ApiProperty({ description: '未读总数' }) unread: number;
}

export class UnreadCountDto {
  @ApiProperty() unread: number;
}

export class NotificationQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '只看未读' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  unreadOnly?: boolean;
}

const notificationSelect = {
  id: true,
  event: true,
  title: true,
  body: true,
  link: true,
  readAt: true,
  createdAt: true,
} as const;

@ApiTags('消息通知')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: '我的站内消息' })
  @ApiOkResponse({ type: NotificationListDto })
  async list(
    @Query() q: NotificationQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<NotificationListDto> {
    const where: Prisma.NotificationWhereInput = {
      userId: user.id,
      ...(q.unreadOnly ? { readAt: null } : {}),
    };
    const [items, total, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        select: notificationSelect,
        orderBy: { createdAt: 'desc' },
        ...skipTake(q),
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    ]);
    return { items, total, unread };
  }

  @Get('unread-count')
  @ApiOperation({ summary: '未读消息数（右上角铃铛）' })
  @ApiOkResponse({ type: UnreadCountDto })
  async unreadCount(@CurrentUser() user: AuthUser): Promise<UnreadCountDto> {
    return {
      unread: await this.prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    };
  }

  @Post(':id/read')
  @HttpCode(200)
  @SkipAudit()
  @ApiOperation({ summary: '标记一条消息已读' })
  @ApiOkResponse({ type: OkDto })
  async read(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<OkDto> {
    await this.prisma.notification.updateMany({
      where: { id, userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  @Post('read-all')
  @HttpCode(200)
  @SkipAudit()
  @ApiOperation({ summary: '全部标记已读' })
  @ApiOkResponse({ type: OkDto })
  async readAll(@CurrentUser() user: AuthUser): Promise<OkDto> {
    await this.prisma.notification.updateMany({
      where: { userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }
}

// ─────────────── 企业微信群机器人管理 ───────────────

export class NotifyChannelDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ example: 'wecom' }) kind: string;
  @ApiProperty({ description: '机器人 key 的头尾几位' }) webhookHint: string;
  @ApiProperty({ type: [String], enum: NOTIFY_EVENT_VALUES }) events: string[];
  @ApiProperty() enabled: boolean;
  @ApiProperty({ type: Date, nullable: true }) lastSentAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) lastError: string | null;
  @ApiProperty({ description: '待发送的消息数' }) pending: number;
  @ApiProperty({ description: '最近 7 天发送失败的消息数' }) failed: number;
  @ApiProperty() createdAt: Date;
}

export class CreateNotifyChannelDto {
  @ApiProperty({ example: '充值群' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name: string;

  @ApiProperty({
    description: '企业微信群机器人地址：群设置 → 群机器人 → 添加 → 复制 Webhook 地址',
    example: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx',
  })
  @IsString()
  @MaxLength(300)
  webhook: string;

  @ApiProperty({ type: [String], enum: NOTIFY_EVENT_VALUES })
  @IsArray()
  @ArrayMaxSize(NOTIFY_EVENT_VALUES.length)
  @IsIn(NOTIFY_EVENT_VALUES, { each: true })
  events: NotifyEvent[];
}

export class UpdateNotifyChannelDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name?: string;

  @ApiPropertyOptional({ description: '换一个机器人地址；不改就不传' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  webhook?: string;

  @ApiPropertyOptional({ type: [String], enum: NOTIFY_EVENT_VALUES })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(NOTIFY_EVENT_VALUES.length)
  @IsIn(NOTIFY_EVENT_VALUES, { each: true })
  events?: NotifyEvent[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class TestResultDto {
  @ApiProperty() ok: boolean;
  @ApiProperty({ type: String, nullable: true }) error: string | null;
}

export class OutboundMessageDto {
  @ApiProperty() id: string;
  @ApiProperty() channelId: string;
  @ApiProperty() channelName: string;
  @ApiProperty({ enum: NOTIFY_EVENT_VALUES }) event: string;
  @ApiProperty() content: string;
  @ApiProperty({ enum: ['PENDING', 'SENT', 'FAILED'] }) status: OutboundStatus;
  @ApiProperty() attempts: number;
  @ApiProperty({ type: String, nullable: true }) lastError: string | null;
  @ApiProperty({ type: Date, nullable: true }) sentAt: Date | null;
  @ApiProperty() createdAt: Date;
}

export class OutboundQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() channelId?: string;

  @ApiPropertyOptional({ enum: ['PENDING', 'SENT', 'FAILED'] })
  @IsOptional()
  @IsIn(['PENDING', 'SENT', 'FAILED'])
  status?: OutboundStatus;
}

export class OutboundListDto {
  @ApiProperty({ type: [OutboundMessageDto] }) items: OutboundMessageDto[];
  @ApiProperty() total: number;
}

function requireWebhook(url: string): string {
  const parsed = parseWecomWebhook(url);
  if (!parsed) {
    throw badRequest(
      '机器人地址不对：应该是 https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=… 这样的地址',
    );
  }
  return parsed.key;
}

@ApiTags('消息通知')
@ApiBearerAuth()
@Controller('notify-channels')
export class NotifyChannelsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBox,
    private readonly sender: WecomSender,
  ) {}

  @Get()
  @RequirePermissions('settings:write')
  @ApiOperation({ summary: '企业微信群机器人列表' })
  @ApiOkResponse({ type: [NotifyChannelDto] })
  async list(): Promise<NotifyChannelDto[]> {
    const since = new Date(Date.now() - 7 * 86_400_000);
    const [channels, pending, failed] = await Promise.all([
      this.prisma.notifyChannel.findMany({ orderBy: { createdAt: 'asc' } }),
      this.prisma.outboundMessage.groupBy({
        by: ['channelId'],
        where: { status: 'PENDING' },
        _count: { _all: true },
      }),
      this.prisma.outboundMessage.groupBy({
        by: ['channelId'],
        where: { status: 'FAILED', createdAt: { gte: since } },
        _count: { _all: true },
      }),
    ]);
    const count = (rows: typeof pending, id: string) =>
      rows.find((r) => r.channelId === id)?._count._all ?? 0;
    return channels.map((c) => ({
      id: c.id,
      name: c.name,
      kind: c.kind,
      webhookHint: c.webhookHint,
      events: c.events,
      enabled: c.enabled,
      lastSentAt: c.lastSentAt,
      lastError: c.lastError,
      pending: count(pending, c.id),
      failed: count(failed, c.id),
      createdAt: c.createdAt,
    }));
  }

  @Post()
  @RequirePermissions('settings:write')
  @Audit('notify.channel.create', '添加企业微信群机器人')
  @ApiOperation({ summary: '添加企业微信群机器人' })
  @ApiOkResponse({ type: OkDto })
  async create(@Body() dto: CreateNotifyChannelDto): Promise<OkDto> {
    const key = requireWebhook(dto.webhook);
    await this.prisma.notifyChannel.create({
      data: {
        name: dto.name.trim(),
        webhookEnc: this.secrets.encrypt(dto.webhook.trim()),
        webhookHint: maskWebhookKey(key),
        events: [...new Set(dto.events)],
      },
    });
    return { ok: true };
  }

  @Patch(':id')
  @RequirePermissions('settings:write')
  @Audit('notify.channel.update', '修改企业微信群机器人')
  @ApiOperation({ summary: '修改群机器人：名称、订阅的事件、停用 / 启用、换地址' })
  @ApiOkResponse({ type: OkDto })
  async update(@Param('id') id: string, @Body() dto: UpdateNotifyChannelDto): Promise<OkDto> {
    await this.require(id);
    const key = dto.webhook ? requireWebhook(dto.webhook) : null;
    await this.prisma.notifyChannel.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.events !== undefined ? { events: [...new Set(dto.events)] } : {}),
        ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
        ...(key
          ? {
              webhookEnc: this.secrets.encrypt(dto.webhook!.trim()),
              webhookHint: maskWebhookKey(key),
              lastError: null,
            }
          : {}),
      },
    });
    return { ok: true };
  }

  @Delete(':id')
  @RequirePermissions('settings:write')
  @Audit('notify.channel.delete', '删除企业微信群机器人')
  @ApiOperation({ summary: '删除群机器人（没发出去的消息一起删除）' })
  @ApiOkResponse({ type: OkDto })
  async remove(@Param('id') id: string): Promise<OkDto> {
    await this.require(id);
    await this.prisma.notifyChannel.delete({ where: { id } });
    return { ok: true };
  }

  @Post(':id/test')
  @HttpCode(200)
  @RequirePermissions('settings:write')
  @Audit('notify.channel.test', '发送群机器人测试消息')
  @ApiOperation({ summary: '马上发一条测试消息到群里' })
  @ApiOkResponse({ type: TestResultDto })
  async test(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<TestResultDto> {
    const channel = await this.require(id);
    const content = [
      '<font color="info">【测试消息】</font>',
      `**代充 CRM 已连上「${plain(channel.name)}」**`,
      `> 由 ${plain(user.displayName)} 在业务设置里发送。之后订阅的事件会推到这个群。`,
    ].join('\n');
    try {
      await this.sender.send(this.secrets.decrypt(channel.webhookEnc), content);
      await this.prisma.notifyChannel.update({
        where: { id },
        data: { lastSentAt: new Date(), lastError: null },
      });
      return { ok: true, error: null };
    } catch (err) {
      const error = (err as Error).message.slice(0, 500);
      await this.prisma.notifyChannel.update({ where: { id }, data: { lastError: error } });
      return { ok: false, error };
    }
  }

  @Get('messages')
  @RequirePermissions('settings:write')
  @ApiOperation({ summary: '群消息发送记录' })
  @ApiOkResponse({ type: OutboundListDto })
  async messages(@Query() q: OutboundQueryDto): Promise<OutboundListDto> {
    const where: Prisma.OutboundMessageWhereInput = {
      ...(q.channelId ? { channelId: q.channelId } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.outboundMessage.findMany({
        where,
        include: { channel: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        ...skipTake(q),
      }),
      this.prisma.outboundMessage.count({ where }),
    ]);
    return {
      total,
      items: rows.map((m) => ({
        id: m.id,
        channelId: m.channelId,
        channelName: m.channel.name,
        event: m.event,
        content: m.content,
        status: m.status as OutboundStatus,
        attempts: m.attempts,
        lastError: m.lastError,
        sentAt: m.sentAt,
        createdAt: m.createdAt,
      })),
    };
  }

  @Post('messages/:id/retry')
  @HttpCode(200)
  @RequirePermissions('settings:write')
  @Audit('notify.message.retry', '重发群消息')
  @ApiOperation({ summary: '重发一条发送失败的群消息' })
  @ApiOkResponse({ type: OkDto })
  async retry(@Param('id') id: string): Promise<OkDto> {
    const r = await this.prisma.outboundMessage.updateMany({
      where: { id, status: 'FAILED' },
      data: { status: 'PENDING', attempts: 0, nextAttemptAt: new Date(), lastError: null },
    });
    if (r.count === 0) throw badRequest('只有发送失败的消息可以重发');
    return { ok: true };
  }

  private async require(id: string) {
    const c = await this.prisma.notifyChannel.findUnique({ where: { id } });
    if (!c) throw notFound('群机器人');
    return c;
  }
}

@Global()
@Module({
  providers: [NotifyService, WecomSender, NotifyDispatcher],
  controllers: [NotificationsController, NotifyChannelsController],
  exports: [NotifyService, WecomSender, NotifyDispatcher],
})
export class NotifyModule {}
