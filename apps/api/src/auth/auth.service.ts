import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { ErrorCode, mergePermissions, widestDataScope, type DataScope } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../common/auth-user';
import type { RequestMeta } from '../common/request-meta';
import { badRequest } from '../common/errors';
import type { LoginResponseDto, ProfileDto, TokenPairDto } from './auth.dto';

export interface AccessPayload {
  sub: string;
  sid: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newRefreshToken = () => randomBytes(48).toString('base64url');

@Injectable()
export class AuthService {
  /** 用户不存在时也做一次哈希比较，避免通过响应时间判断用户名是否存在 */
  private readonly dummyHash = bcrypt.hashSync('timing-safe-dummy-password', 10);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  async login(username: string, password: string, meta: RequestMeta): Promise<LoginResponseDto> {
    const user = await this.prisma.user.findFirst({ where: { username, deletedAt: null } });
    const ok = await bcrypt.compare(password, user?.passwordHash ?? this.dummyHash);
    if (!user || !ok) {
      await this.audit.record({
        action: 'auth.login_failed',
        summary: '登录失败',
        userId: user?.id ?? null,
        detail: { username },
        ip: meta.ip,
      });
      throw new UnauthorizedException({
        code: ErrorCode.INVALID_CREDENTIALS,
        message: '用户名或密码错误',
      });
    }
    if (user.status !== 'ACTIVE') {
      throw new ForbiddenException({
        code: ErrorCode.ACCOUNT_DISABLED,
        message: '账号已停用，请联系管理员',
      });
    }

    const refreshToken = newRefreshToken();
    const session = await this.prisma.session.create({
      data: {
        userId: user.id,
        refreshHash: sha256(refreshToken),
        ip: meta.ip,
        userAgent: meta.userAgent,
        expiresAt: this.refreshExpiry(),
      },
    });
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.record({
      action: 'auth.login',
      summary: '登录',
      userId: user.id,
      ip: meta.ip,
    });

    const authUser = await this.loadAuthUser(user.id, session.id);
    return {
      accessToken: this.signAccess(user.id, session.id),
      refreshToken,
      user: toProfile(authUser!),
    };
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
    const roles = user.roles.map((ur) => ur.role);
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
    };
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
  };
}
