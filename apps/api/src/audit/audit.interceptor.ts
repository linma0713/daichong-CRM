import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable, tap } from 'rxjs';
import type { AuthUser } from '../common/auth-user';
import { AUDIT_KEY, type AuditMeta } from '../auth/decorators';
import { AuditService } from './audit.service';

/** 所有成功的写操作（POST / PATCH / PUT / DELETE）自动记操作日志 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next.handle();
    const meta = this.reflector.get<AuditMeta | undefined>(AUDIT_KEY, ctx.getHandler());
    if (meta?.skip) return next.handle();

    return next.handle().pipe(
      tap((result) => {
        const user = req.user;
        if (!user) return;
        const routePath = (req.route as { path?: string } | undefined)?.path ?? req.path;
        const resultId =
          result && typeof result === 'object' && 'id' in result
            ? String((result as { id: unknown }).id)
            : null;
        void this.audit.record({
          action: meta?.action ?? `${req.method} ${routePath}`,
          summary: meta?.summary ?? `${req.method} ${routePath}`,
          userId: user.id,
          method: req.method,
          path: req.originalUrl.split('?')[0],
          resourceId: (req.params?.id as string | undefined) ?? resultId,
          detail: req.body && Object.keys(req.body).length > 0 ? req.body : undefined,
          ip: req.ip ?? null,
        });
      }),
    );
  }
}
