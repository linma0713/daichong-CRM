import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SCRIPT_CATEGORY_VALUES, type ScriptCategory } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { Audit, CurrentUser, RequirePermissions, SkipAudit } from '../auth/decorators';
import type { AuthUser } from '../common/auth-user';
import { UserBriefDto, userBriefSelect } from '../common/briefs';
import { notFound } from '../common/errors';
import { OkDto } from '../auth/auth.dto';

// ─────────────── DTO ───────────────

export class ScriptQueryDto {
  @ApiPropertyOptional({ enum: SCRIPT_CATEGORY_VALUES })
  @IsOptional()
  @IsIn(SCRIPT_CATEGORY_VALUES)
  category?: ScriptCategory;

  @ApiPropertyOptional({ description: '标题或内容' })
  @IsOptional()
  @IsString()
  keyword?: string;
}

export class CreateScriptDto {
  @ApiProperty({ enum: SCRIPT_CATEGORY_VALUES })
  @IsIn(SCRIPT_CATEGORY_VALUES, { message: '请选择分类' })
  category: ScriptCategory;

  @ApiProperty({ example: '到期前提醒' })
  @IsString()
  @IsNotEmpty({ message: '请输入标题' })
  @MaxLength(40)
  title: string;

  @ApiProperty({ example: '{客户称呼}您好，您的 Claude {套餐} 将在 {到期日} 到期…' })
  @IsString()
  @IsNotEmpty({ message: '请输入话术内容' })
  @MaxLength(2000)
  content: string;

  @ApiPropertyOptional({ description: '同一分类里的排序，小的在前', example: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;
}

export class UpdateScriptDto {
  @ApiPropertyOptional({ enum: SCRIPT_CATEGORY_VALUES })
  @IsOptional()
  @IsIn(SCRIPT_CATEGORY_VALUES)
  category?: ScriptCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  content?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder?: number;
}

export class ScriptDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: SCRIPT_CATEGORY_VALUES }) category: string;
  @ApiProperty() title: string;
  @ApiProperty() content: string;
  @ApiProperty() sortOrder: number;
  @ApiProperty({ description: '被复制的次数' }) useCount: number;
  @ApiProperty({ type: String, nullable: true }) lastUsedAt: Date | null;
  @ApiProperty({ type: UserBriefDto, nullable: true }) createdBy: UserBriefDto | null;
  @ApiProperty() updatedAt: Date;
}

// ─────────────── Service ───────────────

const include = { createdBy: { select: userBriefSelect } } as const;

@Injectable()
export class ScriptsService {
  constructor(private readonly prisma: PrismaService) {}

  list(q: ScriptQueryDto): Promise<ScriptDto[]> {
    const kw = q.keyword?.trim();
    return this.prisma.scriptTemplate.findMany({
      where: {
        category: q.category,
        OR: kw
          ? [
              { title: { contains: kw, mode: 'insensitive' } },
              { content: { contains: kw, mode: 'insensitive' } },
            ]
          : undefined,
      },
      include,
      orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }, { useCount: 'desc' }],
      take: 500,
    });
  }

  create(dto: CreateScriptDto, user: AuthUser): Promise<ScriptDto> {
    return this.prisma.scriptTemplate.create({
      data: {
        category: dto.category,
        title: dto.title.trim(),
        content: dto.content.trim(),
        sortOrder: dto.sortOrder ?? 0,
        createdById: user.id,
      },
      include,
    });
  }

  async update(id: string, dto: UpdateScriptDto): Promise<ScriptDto> {
    await this.find(id);
    return this.prisma.scriptTemplate.update({
      where: { id },
      data: {
        category: dto.category,
        title: dto.title?.trim(),
        content: dto.content?.trim(),
        sortOrder: dto.sortOrder,
      },
      include,
    });
  }

  async remove(id: string): Promise<void> {
    await this.find(id);
    await this.prisma.scriptTemplate.delete({ where: { id } });
  }

  /** 复制了一次：用来把常用话术排前面 */
  async used(id: string): Promise<void> {
    await this.prisma.scriptTemplate.updateMany({
      where: { id },
      data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
    });
  }

  private async find(id: string) {
    const row = await this.prisma.scriptTemplate.findUnique({ where: { id } });
    if (!row) throw notFound('话术');
    return row;
  }
}

// ─────────────── Controller ───────────────

@ApiTags('话术库')
@ApiBearerAuth()
@Controller('scripts')
export class ScriptsController {
  constructor(private readonly scripts: ScriptsService) {}

  @Get()
  @ApiOperation({ summary: '话术列表（所有员工可查看）' })
  @ApiOkResponse({ type: [ScriptDto] })
  list(@Query() q: ScriptQueryDto): Promise<ScriptDto[]> {
    return this.scripts.list(q);
  }

  @Post()
  @RequirePermissions('script:write')
  @Audit('script.create', '新增话术')
  @ApiOperation({ summary: '新增话术' })
  @ApiOkResponse({ type: ScriptDto })
  create(@Body() dto: CreateScriptDto, @CurrentUser() user: AuthUser): Promise<ScriptDto> {
    return this.scripts.create(dto, user);
  }

  @Patch(':id')
  @RequirePermissions('script:write')
  @Audit('script.update', '修改话术')
  @ApiOperation({ summary: '修改话术' })
  @ApiOkResponse({ type: ScriptDto })
  update(@Param('id') id: string, @Body() dto: UpdateScriptDto): Promise<ScriptDto> {
    return this.scripts.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions('script:write')
  @Audit('script.delete', '删除话术')
  @ApiOperation({ summary: '删除话术' })
  @ApiOkResponse({ type: OkDto })
  async remove(@Param('id') id: string): Promise<OkDto> {
    await this.scripts.remove(id);
    return { ok: true };
  }

  @Post(':id/used')
  @HttpCode(200)
  @SkipAudit()
  @ApiOperation({ summary: '记录复制了一次（常用的排前面）' })
  @ApiOkResponse({ type: OkDto })
  async used(@Param('id') id: string): Promise<OkDto> {
    await this.scripts.used(id);
    return { ok: true };
  }
}

@Module({
  providers: [ScriptsService],
  controllers: [ScriptsController],
})
export class ScriptsModule {}
