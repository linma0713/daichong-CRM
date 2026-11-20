import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { skipTake } from '../common/pagination';
import { RequirePermissions } from '../auth/decorators';
import { AuditLogListDto, AuditQueryDto } from './audit.dto';

@ApiTags('操作日志')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequirePermissions('system:audit:read')
  @ApiOperation({ summary: '查询操作日志' })
  @ApiOkResponse({ type: AuditLogListDto })
  async list(@Query() q: AuditQueryDto): Promise<AuditLogListDto> {
    const where: Prisma.AuditLogWhereInput = {
      userId: q.userId,
      action: q.action,
      createdAt:
        q.from || q.to
          ? { gte: q.from ? new Date(q.from) : undefined, lte: q.to ? new Date(q.to) : undefined }
          : undefined,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, username: true, displayName: true } } },
        ...skipTake(q),
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return {
      items: items.map((l) => ({
        id: l.id,
        action: l.action,
        summary: l.summary,
        user: l.user,
        method: l.method,
        path: l.path,
        resourceId: l.resourceId,
        detail: l.detail,
        ip: l.ip,
        createdAt: l.createdAt,
      })),
      total,
    };
  }
}
