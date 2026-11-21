import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import type { User } from '@prisma/client';
import {
  ErrorCode,
  LOGIN_LOCK,
  describeUserAgent,
  mergePermissions,
  normalizeRecoveryCode,
  widestDataScope,
  type DataScope,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotifyService } from '../notify/notify';
import { SecretBox } from '../common/secret-box';
import type { AuthUser } from '../common/auth-user';
import type { RequestMeta } from '../common/request-meta';
import { badRequest } from '../common/errors';
import type { LoginResponseDto, ProfileDto, TokenPairDto } from './auth.dto';
import { hashRecoveryCode, verifyTotp } from './totp';

export interface AccessPayload {
  sub: string;
  sid: string;
}

interface ChallengePayload {
  sub: string;
  purpose: 'login-totp';
}

/** 登录方式，记进操作日志 */
type LoginMethod = 'password' | 'totp' | 'recovery';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newRefreshToken = () => randomBytes(48).toString('base64url');
/** 新设备判断：这么多天内用过的设备算老设备 */
const KNOWN_DEVICE_DAYS = 90;
/** 会话的「最近活跃」最多这么久更新一次，避免每个请求都写库 */
const SEEN_UPDATE_MS = 5 * 60_000;
const TOTP_CHALLENGE_TTL = '5m';

const hhmm = (d: Date) =>
  d.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Asia/Shanghai',
  });

@Injectable()
export class AuthService {
  /** 用户不存在时也做一次哈希比较，避免通过响应时间判断用户名是否存在 */
  private readonly dummyHash = bcrypt.hashSync('timing-safe-dummy-password', 10);
  /** 两步验证的中间令牌用单独的密钥签，不能当登录令牌用 */
  private readonly challengeSecret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly notify: NotifyService,
    private readonly secrets: SecretBox,
  ) {
    this.challengeSecret = `${config.getOrThrow<string>('JWT_ACCESS_SECRET')}:login-totp`;
  }

  /** 第一步：用户名 + 密码。开了两步验证的账号返回中间令牌，等第二步输验证码 */
  async login(
    username: string,
    password: string,
    meta: RequestMeta,
    deviceId?: string,
  ): Promise<LoginResponseDto> {
    const user = await this.prisma.user.findFirst({ where: { username, deletedAt: null } });
    const ok = await bcrypt.compare(password, user?.passwordHash ?? this.dummyHash);
    if (user) this.assertNotLocked(user);
    if (!user || !ok) {
      await this.audit.record({
        action: 'auth.login_failed',
        summary: '登录失败',
        userId: user?.id ?? null,
        detail: { username, device: describeUserAgent(meta.userAgent) },
        ip: meta.ip,
      });
      if (user) await this.registerFailure(user, meta);
      throw new UnauthorizedException({
        code: ErrorCode.INVALID_CREDENTIALS,
        message: '用户名或密码错误',
      });
    }
    this.assertActive(user);

    if (user.totpEnabledAt) {
      const payload: ChallengePayload = { sub: user.id, purpose: 'login-totp' };
      const challenge = await this.jwt.signAsync(payload, {
        secret: this.challengeSecret,
        expiresIn: TOTP_CHALLENGE_TTL,
      });
      return { totpRequired: true, challenge };
    }
    return this.completeLogin(user, meta, 'password', deviceId);
  }

  /** 第二步：手机验证器里的 6 位数字，或者一个恢复码 */
  async loginTotp(
    challenge: string,
    code: string,
    meta: RequestMeta,
    deviceId?: string,
  ): Promise<LoginResponseDto> {
    let payload: ChallengePayload;
    try {
      payload = await this.jwt.verifyAsync<ChallengePayload>(challenge, {
        secret: this.challengeSecret,
      });
      if (payload.purpose !== 'login-totp') throw new Error('purpose');
    } catch {
      throw new UnauthorizedException({
        code: ErrorCode.TOTP_CHALLENGE_EXPIRED,
        message: '登录验证已过期，请重新输入密码',
      });
    }
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.deletedAt || !user.totpEnabledAt || !user.totpSecret) {
      throw new UnauthorizedException({
        code: ErrorCode.TOTP_CHALLENGE_EXPIRED,
        message: '登录验证已过期，请重新输入密码',
      });
    }
    this.assertNotLocked(user);
    this.assertActive(user);

    const recovery = normalizeRecoveryCode(code);
    if (recovery) {
      const hash = hashRecoveryCode(recovery);
      if (user.totpRecoveryHashes.includes(hash)) {
        const left = user.totpRecoveryHashes.filter((h) => h !== hash);
        // 条件更新：并发时同一个恢复码只能用一次
        const used = await this.prisma.user.updateMany({
          where: { id: user.id, totpRecoveryHashes: { has: hash } },
          data: { totpRecoveryHashes: left },
        });
        if (used.count === 1) {
          await this.audit.record({
            action: 'auth.recovery_used',
            summary: '用恢复码登录',
            userId: user.id,
            detail: { left: left.length, device: describeUserAgent(meta.userAgent) },
            ip: meta.ip,
          });
          return this.completeLogin(user, meta, 'recovery', deviceId);
        }
      }
    } else {
      const step = verifyTotp(this.secrets.decrypt(user.totpSecret), code, user.totpLastStep);
      if (step !== null) {
        const used = await this.prisma.user.updateMany({
          where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
          data: { totpLastStep: step },
        });
        if (used.count === 1) return this.completeLogin(user, meta, 'totp', deviceId);
      }
    }

    await this.audit.record({
      action: 'auth.totp_failed',
      summary: '两步验证码错误',
      userId: user.id,
      detail: { device: describeUserAgent(meta.userAgent) },
      ip: meta.ip,
    });
    await this.registerFailure(user, meta);
    throw new UnauthorizedException({
      code: ErrorCode.TOTP_INVALID,
      message: recovery
        ? '恢复码不对或已经用过了'
        : '验证码不对，请输入验证器里当前显示的 6 位数字（手机时间要准）',
    });
  }

  /** 用刷新令牌换一对新令牌，旧的刷新令牌立即失效 */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<TokenPairDto> {
    const session = await this.prisma.session.findUnique({
      where: { refreshHash: sha256(refreshToken) },
      include: { user: true },
    });
    const invalid =
      !session ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() < Date.now() ||
      session.user.deletedAt !== null ||
      session.user.status !== 'ACTIVE';
    if (invalid) {
      throw new UnauthorizedException({
        code: ErrorCode.INVALID_REFRESH_TOKEN,
        message: '登录已过期，请重新登录',
      });
    }
    const next = newRefreshToken();
    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        refreshHash: sha256(next),
        expiresAt: this.refreshExpiry(),
        ip: meta.ip,
        userAgent: meta.userAgent,
        lastSeenAt: new Date(),
      },
    });
    return { accessToken: this.signAccess(session.userId, session.id), refreshToken: next };
  }

  async logout(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async changePassword(user: AuthUser, oldPassword: string, newPassword: string): Promise<void> {
    const record = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await bcrypt.compare(oldPassword, record.passwordHash))) {
      throw badRequest('原密码不正确', ErrorCode.INVALID_CREDENTIALS);
    }
    if (oldPassword === newPassword) throw badRequest('新密码不能和原密码相同');
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: await bcrypt.hash(newPassword, 10), mustChangePassword: false },
      }),
      // 改密码后，其他设备上的登录全部失效
      this.prisma.session.updateMany({
        where: { userId: user.id, id: { not: user.sessionId }, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
  }

  /** 根据令牌里的会话加载员工；会话失效、账号停用都返回 null */
  async loadAuthUser(userId: string, sessionId: string): Promise<AuthUser | null> {
    if (!userId || !sessionId) return null;
    const session = await this.prisma.session.findUnique({ where: { id: sessionId } });
    if (
      !session ||
      session.userId !== userId ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() < Date.now()
    ) {
      return null;
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } } },
    });
    if (!user || user.deletedAt !== null || user.status !== 'ACTIVE') return null;
    if (!session.lastSeenAt || Date.now() - session.lastSeenAt.getTime() > SEEN_UPDATE_MS) {
      await this.prisma.session.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date() },
      });
    }
    const roles = user.roles.map((ur) => ur.role);
    const totpEnabled = user.totpEnabledAt !== null;
    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      teamId: user.teamId,
      sessionId,
      roles: roles.map((r) => ({ id: r.id, code: r.code, name: r.name })),
      permissions: mergePermissions(roles.map((r) => r.permissions)),
      dataScope: widestDataScope(roles.map((r) => r.dataScope as DataScope)),
      mustChangePassword: user.mustChangePassword,
      totpEnabled,
      mustSetupTotp: !totpEnabled && roles.some((r) => r.requireTotp),
    };
  }

  // ─────────────── 内部 ───────────────

  private assertActive(user: User) {
    if (user.status !== 'ACTIVE') {
      throw new ForbiddenException({
        code: ErrorCode.ACCOUNT_DISABLED,
        message: '账号已停用，请联系管理员',
      });
    }
  }

  private assertNotLocked(user: User) {
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new ForbiddenException({
        code: ErrorCode.ACCOUNT_LOCKED,
        message: `密码或验证码连续输错 ${LOGIN_LOCK.maxFailures} 次，账号已锁定，请 ${hhmm(user.lockedUntil)} 以后再试，或者请管理员解锁`,
      });
    }
  }

  /** 输错一次记一次；连续输错到上限就锁定，并提醒本人和能管理员工的人 */
  private async registerFailure(user: User, meta: RequestMeta) {
    const { failedLogins } = await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLogins: { increment: 1 } },
      select: { failedLogins: true },
    });
    if (failedLogins < LOGIN_LOCK.maxFailures) return;
    const until = new Date(Date.now() + LOGIN_LOCK.minutes * 60_000);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { lockedUntil: until, failedLogins: 0 },
      });
      const managers = await this.notify.holders(tx, 'system:user:write');
      await this.notify.emit(tx, {
        event: 'security.locked',
        title: `${user.displayName}（${user.username}）的账号因连续输错被锁定 ${LOGIN_LOCK.minutes} 分钟`,
        body: `最后一次尝试：${describeUserAgent(meta.userAgent)}，IP ${meta.ip ?? '未知'}。如果不是本人在登录，请留意账号安全，必要时修改密码。`,
        to: [user.id, ...managers],
      });
    });
    await this.audit.record({
      action: 'auth.locked',
      summary: '账号被锁定',
      userId: user.id,
      detail: { until: until.toISOString(), device: describeUserAgent(meta.userAgent) },
      ip: meta.ip,
    });
    this.assertNotLocked({ ...user, lockedUntil: until });
  }

  private async completeLogin(
    user: User,
    meta: RequestMeta,
    method: LoginMethod,
    deviceId?: string,
  ): Promise<LoginResponseDto> {
    const newDevice = await this.isNewDevice(user.id, meta, deviceId);
    const refreshToken = newRefreshToken();
    const now = new Date();
    const session = await this.prisma.$transaction(async (tx) => {
      const s = await tx.session.create({
        data: {
          userId: user.id,
          refreshHash: sha256(refreshToken),
          ip: meta.ip,
          userAgent: meta.userAgent,
          deviceId: deviceId ?? null,
          lastSeenAt: now,
          expiresAt: this.refreshExpiry(),
        },
      });
      await tx.user.update({
        where: { id: user.id },
        data: { lastLoginAt: now, failedLogins: 0, lockedUntil: null },
      });
      if (newDevice) {
        await this.notify.emit(tx, {
          event: 'security.new_device',
          title: `你的账号在新设备上登录：${describeUserAgent(meta.userAgent)}`,
          body: `IP ${meta.ip ?? '未知'}，北京时间 ${hhmm(now)}。如果不是你本人，请马上修改密码，并在「账号安全」里退出这个设备。`,
          to: [user.id],
          link: '/account/security',
        });
      }
      return s;
    });
    await this.audit.record({
      action: 'auth.login',
      summary: '登录',
      userId: user.id,
      ip: meta.ip,
      detail: { method, device: describeUserAgent(meta.userAgent), newDevice },
    });

    const authUser = await this.loadAuthUser(user.id, session.id);
    return {
      totpRequired: false,
      accessToken: this.signAccess(user.id, session.id),
      refreshToken,
      user: toProfile(authUser!),
    };
  }

  /**
   * 新设备：浏览器带了设备编号就按编号认，没带（接口调用）就按浏览器 + 系统认。
   * 从没登录过的账号（第一次登录）不算。
   */
  private async isNewDevice(userId: string, meta: RequestMeta, deviceId?: string) {
    const since = new Date(Date.now() - KNOWN_DEVICE_DAYS * 24 * 3600_000);
    const history = await this.prisma.session.findMany({
      where: { userId, createdAt: { gte: since } },
      select: { deviceId: true, userAgent: true },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    if (history.length === 0) {
      return (await this.prisma.session.count({ where: { userId } })) > 0;
    }
    // 升级前的登录记录没有设备编号，这时先按浏览器 + 系统认，免得升级后每个人都收到提醒
    const withIds = history.filter((h) => h.deviceId);
    if (deviceId && withIds.length > 0) return !withIds.some((h) => h.deviceId === deviceId);
    const device = describeUserAgent(meta.userAgent);
    return !history.some((h) => describeUserAgent(h.userAgent) === device);
  }

  private signAccess(userId: string, sessionId: string): string {
    const payload: AccessPayload = { sub: userId, sid: sessionId };
    return this.jwt.sign(payload);
  }

  private refreshExpiry(): Date {
    const days = Number(this.config.get('JWT_REFRESH_TTL_DAYS') ?? 7);
    return new Date(Date.now() + days * 24 * 3600 * 1000);
  }
}

export function toProfile(u: AuthUser): ProfileDto {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    teamId: u.teamId,
    roles: u.roles,
    permissions: u.permissions,
    dataScope: u.dataScope,
    mustChangePassword: u.mustChangePassword,
    totpEnabled: u.totpEnabled,
    mustSetupTotp: u.mustSetupTotp,
  };
}
