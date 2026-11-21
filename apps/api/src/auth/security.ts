import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import * as bcrypt from 'bcryptjs';
import { ErrorCode, describeUserAgent } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SecretBox } from '../common/secret-box';
import type { AuthUser } from '../common/auth-user';
import { requestMeta } from '../common/request-meta';
import { badRequest, notFound } from '../common/errors';
import { OkDto } from './auth.dto';
import {
  AllowPendingPasswordChange,
  AllowPendingTotpSetup,
  Audit,
  CurrentUser,
  SkipAudit,
} from './decorators';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from './totp';

// ─────────────── DTO ───────────────

export class TotpStatusDto {
  @ApiProperty() enabled: boolean;
  @ApiProperty({ type: Date, nullable: true }) enabledAt: Date | null;
  @ApiProperty({ description: '还剩几个恢复码' }) recoveryCodesLeft: number;
  @ApiProperty({ description: '角色要求必须开启（开了以后不能关）' }) required: boolean;
}

export class TotpSetupDto {
  @ApiProperty({ description: '密钥，扫不了码时手动输入' }) secret: string;
  @ApiProperty({ description: '二维码内容' }) otpauthUrl: string;
}

export class TotpCodeDto {
  @ApiProperty({ description: '验证器里的 6 位数字' })
  @IsString()
  @IsNotEmpty({ message: '请输入验证码' })
  @MaxLength(12)
  code: string;
}

export class PasswordConfirmDto {
  @ApiProperty({ description: '当前登录密码' })
  @IsString()
  @IsNotEmpty({ message: '请输入登录密码' })
  @MaxLength(128)
  password: string;
}

export class RecoveryCodesDto {
  @ApiProperty({ type: [String], description: '只显示这一次，请让员工抄下来或下载保存' })
  recoveryCodes: string[];
}

export class SessionDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'Chrome · Windows' }) device: string;
  @ApiProperty({ type: String, nullable: true }) ip: string | null;
  @ApiProperty({ description: '登录时间' }) createdAt: Date;
  @ApiProperty({ type: Date, nullable: true, description: '最近活跃' }) lastSeenAt: Date | null;
  @ApiProperty({ description: '就是现在这个浏览器' }) current: boolean;
}

export class RevokeResultDto {
  @ApiProperty({ description: '退出了几个设备' }) count: number;
}

export class LoginEventDto {
  @ApiProperty() id: string;
  @ApiProperty() at: Date;
  @ApiProperty({ example: 'auth.login' }) action: string;
  @ApiProperty({ example: '登录' }) summary: string;
  @ApiProperty({ type: String, nullable: true }) ip: string | null;
  @ApiProperty({ type: String, nullable: true }) device: string | null;
}

const LOGIN_EVENTS = [
  'auth.login',
  'auth.login_failed',
  'auth.totp_failed',
  'auth.locked',
  'auth.recovery_used',
];

// ─────────────── 会话（登录设备） ───────────────

/** 当前有效的登录：没退出、没过期 */
export function activeSessionWhere(userId: string) {
  return { userId, revokedAt: null, expiresAt: { gt: new Date() } };
}

export function toSessionDto(
  s: {
    id: string;
    userAgent: string | null;
    ip: string | null;
    createdAt: Date;
    lastSeenAt: Date | null;
  },
  currentId?: string,
): SessionDto {
  return {
    id: s.id,
    device: describeUserAgent(s.userAgent),
    ip: s.ip,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    current: s.id === currentId,
  };
}

@Injectable()
export class SecurityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly secrets: SecretBox,
  ) {}

  // ── 两步验证 ──

  async totpStatus(user: AuthUser): Promise<TotpStatusDto> {
    const u = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: {
        totpEnabledAt: true,
        totpRecoveryHashes: true,
        roles: { select: { role: { select: { requireTotp: true } } } },
      },
    });
    return {
      enabled: u.totpEnabledAt !== null,
      enabledAt: u.totpEnabledAt,
      recoveryCodesLeft: u.totpEnabledAt ? u.totpRecoveryHashes.length : 0,
      required: u.roles.some((r) => r.role.requireTotp),
    };
  }

  /**
   * 拿到要扫的密钥（验证通过才算开启）。还没开启时反复打开都是同一个密钥：
   * 扫过一次的人不用重扫，同时打开两次（比如页面重渲染）也不会对不上。
   */
  async setup(user: AuthUser): Promise<TotpSetupDto> {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (u.totpEnabledAt) throw badRequest('两步验证已经开启了');
    if (!u.totpSecret) {
      // 条件更新：并发时只有第一个写进去，后面的读回同一个
      await this.prisma.user.updateMany({
        where: { id: user.id, totpSecret: null, totpEnabledAt: null },
        data: { totpSecret: this.secrets.encrypt(generateTotpSecret()), totpLastStep: null },
      });
    }
    const { totpSecret } = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { totpSecret: true },
    });
    if (!totpSecret) throw badRequest('请关掉弹窗重新打开再试一次');
    const secret = this.secrets.decrypt(totpSecret);
    return { secret, otpauthUrl: otpauthUrl(secret, user.username) };
  }

  async enable(user: AuthUser, code: string, ip: string | null): Promise<RecoveryCodesDto> {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (u.totpEnabledAt) throw badRequest('两步验证已经开启了');
    if (!u.totpSecret) throw badRequest('请先扫码添加到验证器');
    const step = verifyTotp(this.secrets.decrypt(u.totpSecret), code, null);
    if (step === null) {
      throw badRequest('验证码不对，请输入验证器里当前显示的 6 位数字', ErrorCode.TOTP_INVALID);
    }
    const codes = generateRecoveryCodes();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        totpEnabledAt: new Date(),
        totpLastStep: step,
        totpRecoveryHashes: codes.map(hashRecoveryCode),
      },
    });
    await this.audit.record({
      action: 'auth.totp_enable',
      summary: '开启两步验证',
      userId: user.id,
      method: 'POST',
      path: '/api/auth/totp/enable',
      ip,
    });
    return { recoveryCodes: codes };
  }

  async disable(user: AuthUser, password: string, ip: string | null): Promise<void> {
    await this.checkPassword(user.id, password);
    const status = await this.totpStatus(user);
    if (!status.enabled) throw badRequest('两步验证没有开启');
    if (status.required) throw badRequest('你的角色要求必须开启两步验证，不能关闭');
    await this.prisma.user.update({
      where: { id: user.id },
      data: { totpSecret: null, totpEnabledAt: null, totpLastStep: null, totpRecoveryHashes: [] },
    });
    await this.audit.record({
      action: 'auth.totp_disable',
      summary: '关闭两步验证',
      userId: user.id,
      method: 'POST',
      path: '/api/auth/totp/disable',
      ip,
    });
  }

  async regenerateRecoveryCodes(
    user: AuthUser,
    password: string,
    ip: string | null,
  ): Promise<RecoveryCodesDto> {
    await this.checkPassword(user.id, password);
    const status = await this.totpStatus(user);
    if (!status.enabled) throw badRequest('两步验证没有开启');
    const codes = generateRecoveryCodes();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { totpRecoveryHashes: codes.map(hashRecoveryCode) },
    });
    await this.audit.record({
      action: 'auth.recovery_regen',
      summary: '重新生成恢复码',
      userId: user.id,
      method: 'POST',
      path: '/api/auth/totp/recovery-codes',
      ip,
    });
    return { recoveryCodes: codes };
  }

  // ── 登录设备 ──

  async sessions(user: AuthUser): Promise<SessionDto[]> {
    const rows = await this.prisma.session.findMany({
      where: activeSessionWhere(user.id),
      orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    });
    return rows.map((s) => toSessionDto(s, user.sessionId));
  }

  async revoke(user: AuthUser, id: string): Promise<void> {
    if (id === user.sessionId) throw badRequest('这是现在用的浏览器，请用「退出登录」');
    const res = await this.prisma.session.updateMany({
      where: { ...activeSessionWhere(user.id), id },
      data: { revokedAt: new Date() },
    });
    if (res.count === 0) throw notFound('登录设备');
  }

  async revokeOthers(user: AuthUser): Promise<RevokeResultDto> {
    const res = await this.prisma.session.updateMany({
      where: { ...activeSessionWhere(user.id), id: { not: user.sessionId } },
      data: { revokedAt: new Date() },
    });
    return { count: res.count };
  }

  async loginHistory(user: AuthUser): Promise<LoginEventDto[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { userId: user.id, action: { in: LOGIN_EVENTS } },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    return rows.map((r) => ({
      id: r.id,
      at: r.createdAt,
      action: r.action,
      summary: r.summary,
      ip: r.ip,
      device: ((r.detail as { device?: string } | null)?.device as string | undefined) ?? null,
    }));
  }

  private async checkPassword(userId: string, password: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await bcrypt.compare(password, u.passwordHash))) {
      throw badRequest('登录密码不正确', ErrorCode.INVALID_CREDENTIALS);
    }
  }
}

// ─────────────── Controller ───────────────

@ApiTags('登录')
@ApiBearerAuth()
@Controller('auth')
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  @AllowPendingTotpSetup()
  @Get('totp')
  @ApiOperation({ summary: '我的两步验证状态' })
  @ApiOkResponse({ type: TotpStatusDto })
  totpStatus(@CurrentUser() user: AuthUser): Promise<TotpStatusDto> {
    return this.security.totpStatus(user);
  }

  @AllowPendingTotpSetup()
  @SkipAudit()
  @Post('totp/setup')
  @HttpCode(200)
  @ApiOperation({ summary: '开始设置两步验证：生成密钥和二维码' })
  @ApiOkResponse({ type: TotpSetupDto })
  setup(@CurrentUser() user: AuthUser): Promise<TotpSetupDto> {
    return this.security.setup(user);
  }

  @AllowPendingTotpSetup()
  @SkipAudit()
  @Post('totp/enable')
  @HttpCode(200)
  @ApiOperation({ summary: '输入验证码确认，开启两步验证，返回恢复码' })
  @ApiOkResponse({ type: RecoveryCodesDto })
  enable(
    @CurrentUser() user: AuthUser,
    @Body() dto: TotpCodeDto,
    @Req() req: Request,
  ): Promise<RecoveryCodesDto> {
    return this.security.enable(user, dto.code, requestMeta(req).ip);
  }

  @SkipAudit()
  @Post('totp/disable')
  @HttpCode(200)
  @ApiOperation({ summary: '关闭两步验证（要输登录密码）' })
  @ApiOkResponse({ type: OkDto })
  async disable(
    @CurrentUser() user: AuthUser,
    @Body() dto: PasswordConfirmDto,
    @Req() req: Request,
  ): Promise<OkDto> {
    await this.security.disable(user, dto.password, requestMeta(req).ip);
    return { ok: true };
  }

  @SkipAudit()
  @Post('totp/recovery-codes')
  @HttpCode(200)
  @ApiOperation({ summary: '重新生成恢复码，旧的全部作废（要输登录密码）' })
  @ApiOkResponse({ type: RecoveryCodesDto })
  regenerate(
    @CurrentUser() user: AuthUser,
    @Body() dto: PasswordConfirmDto,
    @Req() req: Request,
  ): Promise<RecoveryCodesDto> {
    return this.security.regenerateRecoveryCodes(user, dto.password, requestMeta(req).ip);
  }

  @AllowPendingPasswordChange()
  @Get('sessions')
  @ApiOperation({ summary: '我登录着的设备' })
  @ApiOkResponse({ type: [SessionDto] })
  sessions(@CurrentUser() user: AuthUser): Promise<SessionDto[]> {
    return this.security.sessions(user);
  }

  @Delete('sessions/:id')
  @Audit('auth.session_revoke', '让自己的某个设备退出登录')
  @ApiOperation({ summary: '让某个设备退出登录' })
  @ApiOkResponse({ type: OkDto })
  async revoke(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<OkDto> {
    await this.security.revoke(user, id);
    return { ok: true };
  }

  @Post('sessions/revoke-others')
  @HttpCode(200)
  @Audit('auth.session_revoke_others', '退出自己其他所有设备')
  @ApiOperation({ summary: '除了现在这个浏览器，其他设备全部退出登录' })
  @ApiOkResponse({ type: RevokeResultDto })
  revokeOthers(@CurrentUser() user: AuthUser): Promise<RevokeResultDto> {
    return this.security.revokeOthers(user);
  }

  @Get('login-history')
  @ApiOperation({ summary: '我最近的登录记录（30 条）' })
  @ApiOkResponse({ type: [LoginEventDto] })
  loginHistory(@CurrentUser() user: AuthUser): Promise<LoginEventDto[]> {
    return this.security.loginHistory(user);
  }
}
