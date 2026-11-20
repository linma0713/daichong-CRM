import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { ALL_PERMISSIONS } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';

export class StaffOptionDto {
  @ApiProperty() id: string;
  @ApiProperty() displayName: string;
  @ApiProperty({ type: String, nullable: true }) teamId: string | null;
  @ApiProperty({ description: '能处理开通任务（有充值员权限）' }) canFulfill: boolean;
}

/** 员工下拉选项：选负责人、派任务时使用，所有员工可查看（只含姓名） */
@ApiTags('员工')
@ApiBearerAuth()
@Controller('staff')
export class StaffController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('options')
  @ApiOperation({ summary: '在职员工下拉选项' })
  @ApiOkResponse({ type: [StaffOptionDto] })
  async options(): Promise<StaffOptionDto[]> {
    const users = await this.prisma.user.findMany({
      where: { deletedAt: null, status: 'ACTIVE' },
      include: { roles: { include: { role: { select: { permissions: true } } } } },
      orderBy: { createdAt: 'asc' },
    });
    return users.map((u) => {
      const perms = u.roles.flatMap((r) => r.role.permissions);
      return {
        id: u.id,
        displayName: u.displayName,
        teamId: u.teamId,
        canFulfill: perms.includes('fulfillment:handle') || perms.includes(ALL_PERMISSIONS),
      };
    });
  }
}
