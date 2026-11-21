import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import * as bcrypt from 'bcryptjs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ALL_PERMISSIONS } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RequirePermissions } from '../auth/decorators';
import { SettingsModule, SettingsService } from '../settings/settings';

export type ReadinessStatus = 'ok' | 'info' | 'warn' | 'danger';
const STATUSES: ReadinessStatus[] = ['ok', 'info', 'warn', 'danger'];

export class ReadinessItemDto {
  @ApiProperty({ example: 'account_key' }) key: string;
  @ApiProperty({
    enum: STATUSES,
    enumName: 'ReadinessStatus',
    description: 'ok 已就绪 / info 提示 / warn 建议处理 / danger 上线前必须处理',
  })
  status: ReadinessStatus;
  @ApiProperty({ example: '账号密码加密密钥' }) title: string;
  @ApiProperty({ description: '现在的情况和怎么改' }) detail: string;
}

export class ReadinessDto {
  @ApiProperty({ type: [ReadinessItemDto] }) items: ReadinessItemDto[];
  @ApiProperty() checkedAt: Date;
}

/** 首次初始化用过的默认管理员密码（README 和 .env.example 里写着，谁都知道） */
const KNOWN_DEFAULT_PASSWORDS = ['Admin@123456'];
/** 自动备份超过这么多小时没有更新就报警（每天一次，多留 2 小时余量） */
const BACKUP_STALE_HOURS = 26;

const PRIVATE_HOST =
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?)/i;

function hoursAgo(date: Date, now: Date): number {
  return Math.floor((now.getTime() - date.getTime()) / 3_600_000);
}

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * 上线检查：密钥是不是还用示例值、对外地址、两步验证、模拟收款通道、自动备份、接口文档。
 * 只读，不改任何东西；每项都写清楚怎么改。
 */
@Injectable()
export class ReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly settings: SettingsService,
  ) {}

  async check(now = new Date()): Promise<ReadinessDto> {
    const items: ReadinessItemDto[] = [
      this.jwtSecret(),
      this.accountKey(),
      await this.adminPassword(),
      this.publicUrl(),
      await this.totp(),
      await this.onlinePay(),
      await this.backup(now),
      this.apiDocs(),
    ];
    return { items, checkedAt: now };
  }

  private jwtSecret(): ReadinessItemDto {
    const secret = this.config.get<string>('JWT_ACCESS_SECRET') ?? '';
    const example = /change-me/i.test(secret);
    return {
      key: 'jwt_secret',
      title: '登录令牌密钥（JWT_ACCESS_SECRET）',
      status: example ? 'danger' : 'ok',
      detail: example
        ? '还是 .env.example 里的示例值，知道它的人可以伪造任何员工登录。用 openssl rand -hex 32 生成一个新值填进 .env，重启后所有人重新登录一次即可。'
        : '已经换成自己的密钥。',
    };
  }

  private accountKey(): ReadinessItemDto {
    const key = this.config.get<string>('ACCOUNT_SECRET_KEY') ?? '';
    const example = /^0+$/.test(key);
    return {
      key: 'account_key',
      title: '账号密码加密密钥（ACCOUNT_SECRET_KEY）',
      status: example ? 'danger' : 'ok',
      detail: example
        ? '还是示例密钥（全是 0），Claude 账号密码、卡号、两步验证密钥等于没加密。上线前换成 openssl rand -hex 32 生成的密钥；已经录过敏感信息的，不能直接改，要按部署文档「更换加密密钥」用 rotate-secret-key 重新加密。'
        : '已经换成自己的密钥。请把它另外抄一份保存好：丢了就再也解不开已保存的账号密码。',
    };
  }

  private async adminPassword(): Promise<ReadinessItemDto> {
    const seeded = this.config.get<string>('SEED_ADMIN_PASSWORD');
    const known = [...new Set([...KNOWN_DEFAULT_PASSWORDS, ...(seeded ? [seeded] : [])])];
    const admins = await this.prisma.user.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        roles: { some: { role: { permissions: { has: ALL_PERMISSIONS } } } },
      },
      select: { displayName: true, username: true, passwordHash: true },
    });
    const weak: string[] = [];
    for (const a of admins) {
      for (const pw of known) {
        if (await bcrypt.compare(pw, a.passwordHash)) {
          weak.push(`${a.displayName}（${a.username}）`);
          break;
        }
      }
    }
    return {
      key: 'admin_password',
      title: '管理员密码',
      status: weak.length ? 'danger' : 'ok',
      detail: weak.length
        ? `${weak.join('、')} 还在用初始密码，请马上登录这个账号修改密码。`
        : '管理员都已经改掉了初始密码。',
    };
  }

  private publicUrl(): ReadinessItemDto {
    const url = this.config.get<string>('APP_PUBLIC_URL');
    const base = {
      key: 'public_url',
      title: '对外访问地址（APP_PUBLIC_URL）',
    };
    if (!url) {
      return {
        ...base,
        status: 'warn',
        detail:
          '没有设置：企业微信群消息里没有「在后台打开」链接，收款链接用员工当时打开后台的地址。上云后在 .env 填正式地址，例如 https://crm.example.com。',
      };
    }
    let host = '';
    let https = false;
    try {
      const u = new URL(url);
      host = u.hostname;
      https = u.protocol === 'https:';
    } catch {
      // 启动时已经校验过格式，这里不会到
    }
    if (PRIVATE_HOST.test(host)) {
      return {
        ...base,
        status: 'warn',
        detail: `现在是 ${url}，是本机或局域网地址，客户和外面的人打不开。本机使用没关系；上云后改成正式域名。`,
      };
    }
    if (!https) {
      return {
        ...base,
        status: 'warn',
        detail: `现在是 ${url}，没有用 https，登录密码和数据在网上是明文传的。按部署文档配好域名后改成 https:// 开头。`,
      };
    }
    return { ...base, status: 'ok', detail: `${url}（https）` };
  }

  private async totp(): Promise<ReadinessItemDto> {
    const users = await this.prisma.user.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        totpEnabledAt: null,
        roles: {
          some: {
            role: { permissions: { hasSome: [ALL_PERMISSIONS, 'finance:read', 'refund:approve'] } },
          },
        },
      },
      select: { displayName: true },
      orderBy: { createdAt: 'asc' },
    });
    return {
      key: 'totp',
      title: '管理员和财务的两步验证',
      status: users.length ? 'warn' : 'ok',
      detail: users.length
        ? `${users.map((u) => u.displayName).join('、')} 还没开两步验证。密码泄露时两步验证能挡住别人登录，建议在「系统管理 → 角色与权限」里给管理员、财务打开「必须开启两步验证」。`
        : '能看财务、能审批退款的员工都已经开了两步验证。',
    };
  }

  private async onlinePay(): Promise<ReadinessItemDto> {
    const { onlinePayChannel } = await this.settings.getAll();
    const base = { key: 'online_pay', title: '在线收款通道' };
    if (onlinePayChannel === 'mock') {
      return {
        ...base,
        status: 'danger',
        detail:
          '现在是模拟通道：拿到收款链接的人点一下就算付款成功，系统会自动派开通任务。正式使用前在「业务设置 → 在线收款」改回「不开启」，或者接入真实的支付通道。',
      };
    }
    return {
      ...base,
      status: 'ok',
      detail:
        onlinePayChannel === 'off'
          ? '没有开启，收款照旧由员工手工确认。'
          : `使用 ${onlinePayChannel} 通道。`,
    };
  }

  private async backup(now: Date): Promise<ReadinessItemDto> {
    const dir = this.config.get<string>('BACKUP_DIR');
    const base = { key: 'backup', title: '自动备份' };
    if (!dir) {
      return {
        ...base,
        status: 'warn',
        detail:
          '没有检测到自动备份。上云时按部署文档用 deploy/docker-compose.prod.yml 启动，会每天自动备份数据库和附件；本机使用请定期运行 scripts/backup.sh，并把备份文件拷到别的地方。',
      };
    }
    let newest: { name: string; mtime: Date; size: number } | null = null;
    try {
      for (const name of await readdir(dir)) {
        if (!/^db-.*\.dump$/.test(name)) continue;
        const s = await stat(join(dir, name));
        if (!newest || s.mtime > newest.mtime) newest = { name, mtime: s.mtime, size: s.size };
      }
    } catch {
      return {
        ...base,
        status: 'danger',
        detail: `读不到备份目录 ${dir}，检查 docker-compose.prod.yml 里的挂载。`,
      };
    }
    const lastError = await readFile(join(dir, 'last-error'), 'utf8').catch(() => '');
    if (!newest) {
      return {
        ...base,
        status: 'danger',
        detail: `备份目录里还没有数据库备份。${lastError ? `最近一次失败：${lastError.trim()}` : '检查 backup 容器是否在运行：docker compose logs backup'}`,
      };
    }
    const hours = hoursAgo(newest.mtime, now);
    const when = `${newest.name}（${sizeLabel(newest.size)}，${hours < 1 ? '1 小时内' : `${hours} 小时前`}）`;
    if (hours > BACKUP_STALE_HOURS) {
      return {
        ...base,
        status: 'danger',
        detail: `最近一次备份是 ${when}，已经超过一天没有新的备份。${lastError ? `最近一次失败：${lastError.trim()}` : '检查：docker compose logs backup'}`,
      };
    }
    return {
      ...base,
      status: 'ok',
      detail: `最近一次备份：${when}。备份在服务器的 backups 目录里，建议每周下载一份存到别处。`,
    };
  }

  private apiDocs(): ReadinessItemDto {
    const on = this.config.get<string>('API_DOCS') !== 'off';
    return {
      key: 'api_docs',
      title: '接口文档（/api/docs）',
      status: on ? 'info' : 'ok',
      detail: on
        ? '接口文档对外开放（不登录也能看到有哪些接口，但调用仍要登录）。上云后建议在 .env 设 API_DOCS=off。'
        : '已关闭。',
    };
  }
}

@ApiTags('业务设置')
@ApiBearerAuth()
@Controller('system')
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService) {}

  @Get('readiness')
  @RequirePermissions('settings:write')
  @ApiOperation({ summary: '上线检查：密钥、对外地址、两步验证、收款通道、自动备份' })
  @ApiOkResponse({ type: ReadinessDto })
  check(): Promise<ReadinessDto> {
    return this.readiness.check();
  }
}

@Module({
  imports: [SettingsModule],
  providers: [ReadinessService],
  controllers: [ReadinessController],
})
export class ReadinessModule {}
