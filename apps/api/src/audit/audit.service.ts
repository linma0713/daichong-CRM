import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { redact } from '../common/redact';

export interface AuditEntry {
  action: string;
  summary: string;
  userId?: string | null;
  method?: string | null;
  path?: string | null;
  resourceId?: string | null;
  detail?: unknown;
  ip?: string | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** 写一条操作日志。写日志失败不影响业务本身，只打印错误 */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: entry.action,
          summary: entry.summary,
          userId: entry.userId ?? null,
          method: entry.method ?? null,
          path: entry.path ?? null,
          resourceId: entry.resourceId ?? null,
          detail:
            entry.detail === undefined
              ? Prisma.JsonNull
              : (redact(entry.detail) as Prisma.InputJsonValue),
          ip: entry.ip ?? null,
        },
      });
    } catch (err) {
      this.logger.error(`操作日志写入失败：${(err as Error).message}`);
    }
  }
}
