import { Body, Controller, Get, Injectable, Module, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ONLINE_PAY_CHANNEL_VALUES, PAY_LINK_MINUTES, type OnlinePayChannel } from '@crm/shared';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerStatsService } from '../customers/stats';
import { Audit, CurrentUser, RequirePermissions } from '../auth/decorators';
import type { AuthUser } from '../common/auth-user';

/** 各收款方式的手续费率（万分比，60 = 0.6%） */
export class PaymentFeeRatesDto {
  @ApiProperty({ example: 0 }) @IsInt() @Min(0) @Max(2000) wechat: number = 0;
  @ApiProperty({ example: 0 }) @IsInt() @Min(0) @Max(2000) alipay: number = 0;
  @ApiProperty({ example: 0 }) @IsInt() @Min(0) @Max(2000) usdt: number = 0;
  @ApiProperty({ example: 0 }) @IsInt() @Min(0) @Max(2000) bank: number = 0;
  @ApiProperty({ example: 0 }) @IsInt() @Min(0) @Max(2000) other: number = 0;
}

/** 代理佣金默认比例（万分比，1500 = 15%）；商品或单个代理可以单独设置 */
export class CommissionRatesDto {
  @ApiProperty({ description: '客户首单，直推代理', example: 1500 })
  @IsInt()
  @Min(0)
  @Max(5000)
  first: number = 1500;

  @ApiProperty({ description: '客户之后的订单（续费、再买），直推代理', example: 800 })
  @IsInt()
  @Min(0)
  @Max(5000)
  renewal: number = 800;

  @ApiProperty({ description: '上级代理的管理佣金', example: 300 })
  @IsInt()
  @Min(0)
  @Max(5000)
  parent: number = 300;
}

/** 各类售后工单的处理时限（小时） */
export class TicketSlaHoursDto {
  @ApiProperty({ example: 2 }) @IsInt() @Min(1) @Max(720) NOT_EFFECTIVE: number = 2;
  @ApiProperty({ example: 4 }) @IsInt() @Min(1) @Max(720) BANNED: number = 4;
  @ApiProperty({ example: 8 }) @IsInt() @Min(1) @Max(720) LIMITED: number = 8;
  @ApiProperty({ example: 24 }) @IsInt() @Min(1) @Max(720) REFUND: number = 24;
  @ApiProperty({ example: 4 }) @IsInt() @Min(1) @Max(720) REPLACE: number = 4;
  @ApiProperty({ example: 24 }) @IsInt() @Min(1) @Max(720) OTHER: number = 24;
}

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

  @ApiProperty({
    type: PaymentFeeRatesDto,
    description: '收款手续费率（万分比），确认收款时按收款方式计算手续费，计入每单成本',
  })
  @ValidateNested()
  @Type(() => PaymentFeeRatesDto)
  paymentFeeBp: PaymentFeeRatesDto = new PaymentFeeRatesDto();

  @ApiProperty({ description: '每个套餐的成品号在库数量低于这个值时预警', example: 2 })
  @IsInt()
  @Min(0)
  @Max(1000)
  accountStockLow: number = 2;

  @ApiProperty({
    type: TicketSlaHoursDto,
    description: '售后工单按类型的处理时限（小时），超时自动升级',
  })
  @ValidateNested()
  @Type(() => TicketSlaHoursDto)
  ticketSlaHours: TicketSlaHoursDto = new TicketSlaHoursDto();

  @ApiProperty({ description: '工单标记「已解决」后多少小时自动关闭', example: 48 })
  @IsInt()
  @Min(1)
  @Max(720)
  ticketAutoCloseHours: number = 48;

  @ApiProperty({
    type: CommissionRatesDto,
    description: '代理佣金默认比例（万分比）；只影响之后的新订单',
  })
  @ValidateNested()
  @Type(() => CommissionRatesDto)
  commissionRatesBp: CommissionRatesDto = new CommissionRatesDto();

  @ApiProperty({ description: '没加购质保的订单，完成后冻结几天佣金才能结算', example: 7 })
  @IsInt()
  @Min(0)
  @Max(90)
  commissionFreezeDays: number = 7;

  @ApiProperty({ description: '佣金基数是否包含质保费', example: false })
  @IsBoolean()
  commissionIncludeWarranty: boolean = false;

  @ApiProperty({ description: '每天几点（北京时间）往企业微信群推送早报', example: 9 })
  @IsInt()
  @Min(0)
  @Max(23)
  dailyDigestHour: number = 9;

  @ApiProperty({ description: '累计实付满多少（分）算 VIP 客户', example: 300000 })
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  vipThresholdCents: number = 300000;

  @ApiProperty({
    description: '服务结束后多少天内算「沉睡」（召回期），超过算「流失」',
    example: 30,
  })
  @IsInt()
  @Min(1)
  @Max(365)
  recallWindowDays: number = 30;

  @ApiProperty({
    description: '转介绍奖励（分）：老客户推荐的新客户第一次收齐款时奖励推荐人；0 = 不发',
    example: 5000,
  })
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  referralRewardCents: number = 0;

  @ApiProperty({
    enum: ONLINE_PAY_CHANNEL_VALUES,
    description:
      '在线收款通道：off 不开启；mock 模拟通道（只用于测试，拿到链接的人都能点「付款成功」）',
    example: 'off',
  })
  @IsIn(ONLINE_PAY_CHANNEL_VALUES)
  onlinePayChannel: OnlinePayChannel = 'off';

  @ApiProperty({ description: '收款链接多少分钟内有效', example: PAY_LINK_MINUTES.default })
  @IsInt()
  @Min(PAY_LINK_MINUTES.min)
  @Max(PAY_LINK_MINUTES.max)
  payLinkMinutes: number = PAY_LINK_MINUTES.default;

  @ApiProperty({ description: '客户付款页上显示的店铺名称；空着只显示「订单付款」', example: '' })
  @IsString()
  @MaxLength(30)
  payShopName: string = '';
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

  @ApiProperty({ required: false, type: PaymentFeeRatesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PaymentFeeRatesDto)
  paymentFeeBp?: PaymentFeeRatesDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  accountStockLow?: number;

  @ApiProperty({ required: false, type: TicketSlaHoursDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => TicketSlaHoursDto)
  ticketSlaHours?: TicketSlaHoursDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(720)
  ticketAutoCloseHours?: number;

  @ApiProperty({ required: false, type: CommissionRatesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CommissionRatesDto)
  commissionRatesBp?: CommissionRatesDto;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(90)
  commissionFreezeDays?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  commissionIncludeWarranty?: boolean;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  dailyDigestHour?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  vipThresholdCents?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(365)
  recallWindowDays?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  referralRewardCents?: number;

  @ApiProperty({ required: false, enum: ONLINE_PAY_CHANNEL_VALUES })
  @IsOptional()
  @IsIn(ONLINE_PAY_CHANNEL_VALUES)
  onlinePayChannel?: OnlinePayChannel;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsInt()
  @Min(PAY_LINK_MINUTES.min)
  @Max(PAY_LINK_MINUTES.max)
  payLinkMinutes?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  payShopName?: string;
}

type SettingKey = keyof BusinessSettingsDto;
const KEYS: SettingKey[] = [
  'exchangeRate',
  'reminderDays',
  'activateSlaHours',
  'upstreamLeadDays',
  'paymentFeeBp',
  'accountStockLow',
  'ticketSlaHours',
  'ticketAutoCloseHours',
  'commissionRatesBp',
  'commissionFreezeDays',
  'commissionIncludeWarranty',
  'dailyDigestHour',
  'vipThresholdCents',
  'recallWindowDays',
  'referralRewardCents',
  'onlinePayChannel',
  'payLinkMinutes',
  'payShopName',
];
/** 存成对象的设置项：读取时和默认值合并，新增字段有默认值 */
const OBJECT_DEFAULTS: Partial<Record<SettingKey, () => object>> = {
  paymentFeeBp: () => new PaymentFeeRatesDto(),
  ticketSlaHours: () => new TicketSlaHoursDto(),
  commissionRatesBp: () => new CommissionRatesDto(),
};

@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stats: CustomerStatsService,
  ) {}

  async getAll(): Promise<BusinessSettingsDto> {
    const rows = await this.prisma.setting.findMany({ where: { key: { in: KEYS } } });
    const result = new BusinessSettingsDto();
    for (const row of rows) {
      const defaults = OBJECT_DEFAULTS[row.key as SettingKey];
      const value = defaults ? { ...defaults(), ...(row.value as object) } : row.value;
      (result as unknown as Record<string, unknown>)[row.key] = value;
    }
    return {
      ...result,
      paymentFeeBp: { ...result.paymentFeeBp },
      ticketSlaHours: { ...result.ticketSlaHours },
      commissionRatesBp: { ...result.commissionRatesBp },
    };
  }

  async update(dto: UpdateSettingsDto, userId: string): Promise<BusinessSettingsDto> {
    const ops: Prisma.PrismaPromise<unknown>[] = [];
    for (const key of KEYS) {
      const value = dto[key];
      if (value === undefined) continue;
      const json = (
        key === 'reminderDays'
          ? [...new Set(value as number[])].sort((a, b) => b - a)
          : key === 'payShopName'
            ? (value as string).trim()
            : OBJECT_DEFAULTS[key]
              ? { ...(value as object) }
              : value
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
    // 召回期变了，沉睡 / 流失的划分跟着变
    if (dto.recallWindowDays !== undefined) await this.stats.refresh(this.prisma);
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
  update(
    @Body() dto: UpdateSettingsDto,
    @CurrentUser() user: AuthUser,
  ): Promise<BusinessSettingsDto> {
    return this.settings.update(dto, user.id);
  }
}

@Module({
  providers: [SettingsService],
  controllers: [SettingsController],
  exports: [SettingsService],
})
export class SettingsModule {}
