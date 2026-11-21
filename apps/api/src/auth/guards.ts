import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ErrorCode, hasPermission } from '@crm/shared';
import type { AuthUser } from '../common/auth-user';
import {
  ALLOW_PENDING_PASSWORD_KEY,
  ALLOW_PENDING_TOTP_KEY,
  ANY_PERMISSIONS_KEY,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
} from './decorators';

/** 全局登录校验：除了 @Public() 的接口都要带有效令牌 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(ctx: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(ctx);
  }

  handleRequest<T>(err: unknown, user: T): T {
    if (err) throw err;
    if (!user) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: '请先登录' });
    }
    return user;
  }
}

/** 全局权限校验：检查 @RequirePermissions()，并拦住还没改初始密码、还没按要求开两步验证的账号 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const user = ctx.switchToHttp().getRequest().user as AuthUser | undefined;
    if (!user) return false;

    const allowPending = this.reflector.getAllAndOverride<boolean>(
      ALLOW_PENDING_PASSWORD_KEY,
      targets,
    );
    if (user.mustChangePassword && !allowPending) {
      throw new ForbiddenException({
        code: ErrorCode.PASSWORD_CHANGE_REQUIRED,
        message: '请先修改初始密码',
      });
    }
    const allowPendingTotp = this.reflector.getAllAndOverride<boolean>(
      ALLOW_PENDING_TOTP_KEY,
      targets,
    );
    if (user.mustSetupTotp && !allowPending && !allowPendingTotp) {
      throw new ForbiddenException({
        code: ErrorCode.TOTP_SETUP_REQUIRED,
        message: '你的角色要求开启两步验证，请先完成设置',
      });
    }

    const all = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets) ?? [];
    const any = this.reflector.getAllAndOverride<string[]>(ANY_PERMISSIONS_KEY, targets) ?? [];
    const allOk = all.every((p) => hasPermission(user.permissions, p));
    const anyOk = any.length === 0 || any.some((p) => hasPermission(user.permissions, p));
    if (allOk && anyOk) return true;
    throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: '没有权限执行这个操作' });
  }
}
