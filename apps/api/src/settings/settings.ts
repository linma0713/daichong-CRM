import { Body, Controller, Get, Injectable, Module, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Audit, CurrentUser, RequirePermissions } from '../auth/decorators';
import type { AuthUser } from '../common/auth-user';

/** 业务设置及默认值。新增设置项时在这里加一项即可 */
export class BusinessSettingsDto {
  @ApiProperty({ description: '美元兑人民币汇率，用于估算成本和毛利', example: 7.2 })
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(1)
  @Max(20)
  exchangeRate: number = 7.2;

  @ApiProperty({
    type: [Number],
    description: '到期前几天提醒客服跟进续费',
    example: [7, 3, 1],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(60, { each: true })
  reminderDays: number[] = [7, 3, 1];

  @ApiProperty({ description: '开通 / 续费任务要在收款后几小时内完成', example: 2 })
  @IsInt()
  @Min(1)
  @Max(72)
  activateSlaHours: number = 2;

  @ApiProperty({
    description: '上游扣费前几天生成内部续费或取消自动续订任务',
    example: 2,
  })
  @IsInt()
  @Min(1)
  @Max(10)
  upstreamLeadDays: number = 2;
}

export class UpdateSettingsDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(1)
  @Max(20)
  exchangeRate?: number;

  @ApiProperty({ required: false, type: [Number] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(60, { each: true })
  reminderDays?: number[];

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(72)
  activateSlaHours?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  upstreamLeadDays?: number;
}

type SettingKey = keyof BusinessSettingsDto;
const KEYS: SettingKey[] = ['exchangeRate', 'reminderDays', 'activateSlaHours', 'upstreamLeadDays'];

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getAll(): Promise<BusinessSettingsDto> {
    const rows = await this.prisma.setting.findMany({ where: { key: { in: KEYS } } });
    const result = new BusinessSettingsDto();
    for (const row of rows) {
      (result as unknown as Record<string, unknown>)[row.key] = row.value;
    }
    return { ...result };
  }

  async update(dto: UpdateSettingsDto, userId: string): Promise<BusinessSettingsDto> {
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    for (const key of KEYS) {
      const value = dto[key];
      if (value === undefined) continue;
      const json = (
        key === 'reminderDays' ? [...new Set(value as number[])].sort((a, b) => b - a) : value
      ) as Prisma.InputJsonValue;
      ops.push(
        this.prisma.setting.upsert({
          where: { key },
          create: { key, value: json, updatedById: userId },
          update: { value: json, updatedById: userId },
        }),
      );
    }
    await this.prisma.$transaction(ops);
    return this.getAll();
  }
}

@ApiTags('业务设置')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  @ApiOperation({ summary: '业务设置（所有员工可查看）' })
  @ApiOkResponse({ type: BusinessSettingsDto })
  get(): Promise<BusinessSettingsDto> {
    return this.settings.getAll();
  }

  @Patch()
  @RequirePermissions('settings:write')
  @Audit('settings.update', '修改业务设置')
  @ApiOperation({ summary: '修改业务设置' })
  @ApiOkResponse({ type: BusinessSettingsDto })
  update(@Body() dto: UpdateSettingsDto, @CurrentUser() user: AuthUser): Promise<BusinessSettingsDto> {
    return this.settings.update(dto, user.id);
  }
}

@Module({
  providers: [SettingsService],
  controllers: [SettingsController],
  exports: [SettingsService],
})
export class SettingsModule {}
