import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { badRequest } from '../common/errors';
import { OkDto } from '../auth/auth.dto';
import { Audit, RequirePermissions } from '../auth/decorators';

export class SaveTeamDto {
  @ApiProperty({ example: '客服一组' })
  @IsString()
  @IsNotEmpty({ message: '请输入小组名称' })
  @MaxLength(32)
  name: string;
}

export class TeamDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() userCount: number;
}

@Injectable()
export class TeamsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<TeamDto[]> {
    const teams = await this.prisma.team.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { users: { where: { deletedAt: null } } } } },
    });
    return teams.map((t) => ({ id: t.id, name: t.name, userCount: t._count.users }));
  }

  async create(name: string): Promise<TeamDto> {
    await this.assertNameFree(name);
    const t = await this.prisma.team.create({ data: { name } });
    return { id: t.id, name: t.name, userCount: 0 };
  }

  async rename(id: string, name: string): Promise<TeamDto> {
    await this.findOrThrow(id);
    await this.assertNameFree(name, id);
    await this.prisma.team.update({ where: { id }, data: { name } });
    return (await this.list()).find((t) => t.id === id)!;
  }

  async remove(id: string): Promise<void> {
    await this.findOrThrow(id);
    const members = await this.prisma.user.count({ where: { teamId: id, deletedAt: null } });
    if (members > 0) throw badRequest('小组里还有员工，请先将这些员工移出小组');
    await this.prisma.team.delete({ where: { id } });
  }

  private async findOrThrow(id: string) {
    const t = await this.prisma.team.findUnique({ where: { id } });
    if (!t) throw new NotFoundException({ code: 'NOT_FOUND', message: '小组不存在' });
    return t;
  }

  private async assertNameFree(name: string, exceptId?: string) {
    const t = await this.prisma.team.findUnique({ where: { name } });
    if (t && t.id !== exceptId) throw badRequest('已经有同名的小组');
  }
}

@ApiTags('小组')
@ApiBearerAuth()
@Controller('teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @RequirePermissions('system:user:read')
  @ApiOperation({ summary: '小组列表' })
  @ApiOkResponse({ type: [TeamDto] })
  list(): Promise<TeamDto[]> {
    return this.teams.list();
  }

  @Post()
  @RequirePermissions('system:team:write')
  @Audit('team.create', '新增小组')
  @ApiOperation({ summary: '新增小组' })
  @ApiOkResponse({ type: TeamDto })
  create(@Body() dto: SaveTeamDto): Promise<TeamDto> {
    return this.teams.create(dto.name);
  }

  @Patch(':id')
  @RequirePermissions('system:team:write')
  @Audit('team.update', '重命名小组')
  @ApiOperation({ summary: '重命名小组' })
  @ApiOkResponse({ type: TeamDto })
  rename(@Param('id') id: string, @Body() dto: SaveTeamDto): Promise<TeamDto> {
    return this.teams.rename(id, dto.name);
  }

  @Delete(':id')
  @RequirePermissions('system:team:write')
  @Audit('team.delete', '删除小组')
  @ApiOperation({ summary: '删除小组' })
  @ApiOkResponse({ type: OkDto })
  async remove(@Param('id') id: string): Promise<OkDto> {
    await this.teams.remove(id);
    return { ok: true };
  }
}

@Module({
  controllers: [TeamsController],
  providers: [TeamsService],
})
export class TeamsModule {}
