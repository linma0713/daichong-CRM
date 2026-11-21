import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { AuthUser } from '../common/auth-user';

export const IS_PUBLIC_KEY = 'crm:isPublic';
export const PERMISSIONS_KEY = 'crm:permissions';
export const ANY_PERMISSIONS_KEY = 'crm:anyPermissions';
export const ALLOW_PENDING_PASSWORD_KEY = 'crm:allowPendingPassword';
export const ALLOW_PENDING_TOTP_KEY = 'crm:allowPendingTotp';
export const AUDIT_KEY = 'crm:audit';

/** 不需要登录即可访问 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** 需要同时拥有这些权限 */
export const RequirePermissions = (...codes: string[]) => SetMetadata(PERMISSIONS_KEY, codes);

/** 拥有其中任意一个权限即可（例如编辑员工时需要读取角色下拉选项） */
export const RequireAnyPermission = (...codes: string[]) => SetMetadata(ANY_PERMISSIONS_KEY, codes);

/** 还没改初始密码时也允许访问（登录信息、改密码、退出） */
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PENDING_PASSWORD_KEY, true);

/** 角色要求两步验证但还没开启时，也允许调用（设置两步验证用的接口） */
export const AllowPendingTotpSetup = () => SetMetadata(ALLOW_PENDING_TOTP_KEY, true);

export interface AuditMeta {
  action?: string;
  summary?: string;
  skip?: boolean;
}

/** 给写操作起一个看得懂的名字，写进操作日志 */
export const Audit = (action: string, summary: string) =>
  SetMetadata(AUDIT_KEY, { action, summary } satisfies AuditMeta);

/** 这个接口自己记日志或不需要记 */
export const SkipAudit = () => SetMetadata(AUDIT_KEY, { skip: true } satisfies AuditMeta);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user as AuthUser;
});
