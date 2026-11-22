import {
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
  Query,
  Req,
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
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { Request } from 'express';
import { Prisma } from '@prisma/client';
import {
  ACCOUNT_STOCK_STATUSES,
  RESOURCE_TX_TYPES,
  RESOURCE_TYPES,
  displayNo,
  type AccountStockStatus,
  type ResourceTxType,
  type ResourceType,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Audit, CurrentUser, RequireAnyPermission, RequirePermissions } from '../auth/decorators';
import type { AuthUser } from '../common/auth-user';
import {
  CustomerBriefDto,
  UserBriefDto,
  customerBriefSelect,
  userBriefSelect,
} from '../common/briefs';
import { addMonths, maxDate } from '../common/dates';
import { badRequest, notFound } from '../common/errors';
import { PageQueryDto, skipTake } from '../common/pagination';
import { SecretBox } from '../common/secret-box';
import { RefDto, toCustomerBrief } from '../orders/orders';
import { SettingsModule, SettingsService } from '../settings/settings';
import { LedgerModule, LedgerService } from './ledger';

// ─────────────── DTO：付款资源 ───────────────

export class ResourceDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'R00003' }) code: string;
  @ApiProperty({ enum: RESOURCE_TYPES, enumName: 'ResourceType' }) type: ResourceType;
  @ApiProperty() name: string;
  @ApiProperty({ type: String, nullable: true }) last4: string | null;
  @ApiProperty({ description: '账面余额（美分）' }) balanceUsdCents: number;
  @ApiProperty({ description: '余额对应的人民币成本（分）' }) costPoolCents: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: '平均成本：每 1 美元合多少元人民币（余额为 0 时为空）',
  })
  avgRate: number | null;
  @ApiProperty({ description: '每笔扣费手续费比例（万分比）' }) feeBp: number;
  @ApiProperty({ description: '每笔扣费固定手续费（美分）' }) feeFixedUsdCents: number;
  @ApiProperty({ description: '低于这个余额预警（美分）' }) lowBalanceUsdCents: number;
  @ApiProperty({ description: '余额低于预警线' }) low: boolean;
  @ApiProperty() active: boolean;
  @ApiProperty() hasSecretNote: boolean;
  @ApiProperty({ description: '是否录入了完整卡号' }) hasCardNumber: boolean;
  @ApiProperty({ type: String, nullable: true, description: '持卡人实名' })
  holderName: string | null;
  @ApiProperty({ type: String, nullable: true }) remark: string | null;
  @ApiProperty() createdAt: Date;
}

const CARD_NUMBER_HINT =
  '完整卡号，可以带空格或横线；填了会自动取后四位（加密保存，查看会记录日志）';

export class CreateResourceDto {
  @ApiProperty({ enum: RESOURCE_TYPES, enumName: 'ResourceType' })
  @IsIn(RESOURCE_TYPES)
  type: ResourceType;

  @ApiProperty({ example: 'Visa 虚拟卡 A' })
  @IsString()
  @IsNotEmpty({ message: '请输入名称' })
  @MaxLength(50)
  name: string;

  @ApiPropertyOptional({ example: '1234' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  last4?: string;

  @ApiPropertyOptional({ description: '每笔扣费手续费比例（万分比，150 = 1.5%）' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2000)
  feeBp?: number;

  @ApiPropertyOptional({ description: '每笔扣费固定手续费（美分）' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  feeFixedUsdCents?: number;

  @ApiPropertyOptional({ description: '余额低于这个值预警（美分）' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_00)
  lowBalanceUsdCents?: number;

  @ApiPropertyOptional({ description: CARD_NUMBER_HINT, example: '4111 1111 1111 1111' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  cardNumber?: string;

  @ApiPropertyOptional({ description: '持卡人实名', example: '王小明' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  holderName?: string;

  @ApiPropertyOptional({ description: 'CVV、登录信息等（加密保存，查看会记录日志）' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  secretNote?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string;

  @ApiPropertyOptional({ description: '首次入库的美元金额（美分）' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_00)
  initialUsdCents?: number;

  @ApiPropertyOptional({ description: '首次入库实际花的人民币（分）' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_00)
  initialCnyCents?: number;
}

export class UpdateResourceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  last4?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2000)
  feeBp?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  feeFixedUsdCents?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_00)
  lowBalanceUsdCents?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ description: `${CARD_NUMBER_HINT}；传空字符串表示清除` })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  cardNumber?: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: '持卡人实名；传空表示清除' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  holderName?: string | null;

  @ApiPropertyOptional({ description: '新的敏感信息；传空字符串表示清除' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  secretNote?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string | null;
}

export class TopUpDto {
  @ApiProperty({ description: '入库美元（美分）' })
  @IsInt()
  @Min(1, { message: '入库金额必须大于 0' })
  @Max(100_000_00)
  usdCents: number;

  @ApiProperty({ description: '实际花的人民币（分），含买卡折扣、充值手续费' })
  @IsInt()
  @Min(0)
  @Max(1_000_000_00)
  cnyCents: number;

  @ApiPropertyOptional({ example: '闲鱼买 $100 礼品卡' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class AdjustDto {
  @ApiProperty({ description: '实际余额（美分）' })
  @IsInt()
  @Min(0)
  @Max(100_000_00)
  actualUsdCents: number;

  @ApiProperty({ example: '月底对账，实际余额以卡商后台为准' })
  @IsString()
  @IsNotEmpty({ message: '请填写调整原因' })
  @MaxLength(200)
  note: string;
}

export class ResourceTxQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: RESOURCE_TX_TYPES, enumName: 'ResourceTxType' })
  @IsOptional()
  @IsIn(RESOURCE_TX_TYPES)
  type?: ResourceTxType;
}

export class ResourceTxDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: RESOURCE_TX_TYPES, enumName: 'ResourceTxType' }) type: ResourceTxType;
  @ApiProperty({ description: '美元变动（美分），入正出负' }) usdCents: number;
  @ApiProperty({ description: '人民币变动（分）' }) cnyCents: number;
  @ApiProperty() balanceAfterUsdCents: number;
  @ApiProperty({ type: String, nullable: true }) note: string | null;
  @ApiProperty({ type: RefDto, nullable: true, description: '成本归属的订单' })
  order: RefDto | null;
  @ApiProperty({ type: UserBriefDto }) user: UserBriefDto;
  @ApiProperty() createdAt: Date;
}

export class ResourceTxListDto {
  @ApiProperty({ type: [ResourceTxDto] }) items: ResourceTxDto[];
  @ApiProperty() total: number;
}

export class ResourceCardDto {
  @ApiProperty() name: string;
  @ApiProperty({ type: String, nullable: true }) last4: string | null;
  @ApiProperty({ type: String, nullable: true }) holderName: string | null;
  @ApiProperty({ type: String, nullable: true, description: '完整卡号（没录入时为空）' })
  cardNumber: string | null;
}

export class RevealCardQueryDto {
  @ApiPropertyOptional({ description: '从哪张订单点开的（写进操作日志）' })
  @IsOptional()
  @IsString()
  orderId?: string;
}

export class ResourceSecretDto {
  @ApiProperty() name: string;
  @ApiProperty({ type: String, nullable: true }) secretNote: string | null;
}

// ─────────────── DTO：成品号库存 ───────────────

export class PlanRefDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
}

export class StockAccountDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty({ type: PlanRefDto, nullable: true }) plan: PlanRefDto | null;
  @ApiProperty({ enum: ACCOUNT_STOCK_STATUSES, enumName: 'AccountStockStatus' })
  stockStatus: AccountStockStatus;
  @ApiProperty({ description: '还没结转的备号成本（分）' }) stockCostCents: number;
  @ApiProperty({ type: String, nullable: true, description: '上游已付费到这一天' })
  upstreamRenewAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) stockedAt: Date | null;
  @ApiProperty({ type: CustomerBriefDto, nullable: true, description: '使用中的客户' })
  customer: CustomerBriefDto | null;
  @ApiProperty({ type: RefDto, nullable: true, description: '服务中的订阅' })
  subscription: RefDto | null;
  @ApiProperty() hasPassword: boolean;
  @ApiProperty() hasSecretNote: boolean;
  @ApiProperty({ type: String, nullable: true }) remark: string | null;
  @ApiProperty() createdAt: Date;
}

export class StockAccountListDto {
  @ApiProperty({ type: [StockAccountDto] }) items: StockAccountDto[];
  @ApiProperty() total: number;
}

export class StockAccountQueryDto extends PageQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  planId?: string;

  @ApiPropertyOptional({ enum: ACCOUNT_STOCK_STATUSES, enumName: 'AccountStockStatus' })
  @IsOptional()
  @IsIn(ACCOUNT_STOCK_STATUSES)
  status?: AccountStockStatus;

  @ApiPropertyOptional({ description: '账号邮箱' })
  @IsOptional()
  @IsString()
  keyword?: string;
}

export class NewStockAccountDto {
  @ApiProperty()
  @IsEmail({}, { message: '账号邮箱格式不正确' })
  email: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: '请填写密码' })
  @MaxLength(200)
  password: string;

  @ApiPropertyOptional({ description: '恢复邮箱、备用码等' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  secretNote?: string;
}

export class CreateStockAccountsDto {
  @ApiProperty({ description: '入哪个套餐的库存' })
  @IsString()
  planId: string;

  @ApiProperty({ type: [NewStockAccountDto] })
  @IsArray()
  @ArrayMinSize(1, { message: '至少录入一个账号' })
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => NewStockAccountDto)
  accounts: NewStockAccountDto[];

  @ApiPropertyOptional({ description: '每个号的其他成本（分），例如买号、邮箱费用' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_00)
  costCnyCents?: number;

  @ApiPropertyOptional({ description: '用哪个付款资源给每个号付第一个月' })
  @IsOptional()
  @IsString()
  resourceId?: string;

  @ApiPropertyOptional({ description: '每个号的上游扣费（美分，不含手续费），默认套餐官方月费' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000_00)
  chargeUsdCents?: number;

  @ApiPropertyOptional({ description: '上游已付费到这一天；登记了付款时默认一个月后' })
  @IsOptional()
  @IsDateString()
  upstreamRenewAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string;
}

export class SkippedAccountDto {
  @ApiProperty() email: string;
  @ApiProperty() reason: string;
}

export class CreateStockAccountsResultDto {
  @ApiProperty() created: number;
  @ApiProperty({ type: [SkippedAccountDto] }) skipped: SkippedAccountDto[];
}

export class UpdateStockAccountDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  planId?: string;

  @ApiPropertyOptional({
    enum: ['IN_STOCK', 'VOID'],
    description: '在库 / 作废（使用中的号不能改）',
  })
  @IsOptional()
  @IsIn(['IN_STOCK', 'VOID'])
  stockStatus?: 'IN_STOCK' | 'VOID';

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsDateString()
  upstreamRenewAt?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string | null;
}

export class ChargeStockAccountDto {
  @ApiProperty()
  @IsString()
  resourceId: string;

  @ApiPropertyOptional({ description: '上游扣费（美分，不含手续费），默认套餐官方月费' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000_00)
  usdCents?: number;

  @ApiPropertyOptional({ description: '付费后上游下次扣费时间，默认顺延一个月' })
  @IsOptional()
  @IsDateString()
  upstreamRenewAt?: string;
}

export class StockPoolDto {
  @ApiProperty() planId: string;
  @ApiProperty() planName: string;
  @ApiProperty({ description: '在库数量' }) inStock: number;
  @ApiProperty({ description: '使用中数量' }) inUse: number;
  @ApiProperty({ description: '在库数量低于预警线' }) low: boolean;
}

export class InventorySummaryDto {
  @ApiProperty({ type: [StockPoolDto] }) pools: StockPoolDto[];
  @ApiProperty({ description: '成品号预警线（每个套餐）' }) accountStockLow: number;
  @ApiProperty({ type: [ResourceDto], description: '余额低于预警线的付款资源' })
  lowResources: ResourceDto[];
  @ApiProperty({ description: '可用付款资源的美元余额合计（美分）' }) totalBalanceUsdCents: number;
  @ApiProperty({ description: '可用付款资源的人民币成本合计（分）' }) totalCostPoolCents: number;
}

// ─────────────── Service ───────────────

type ResourceRow = Prisma.PaymentResourceGetPayload<object>;

function toResourceDto(r: ResourceRow): ResourceDto {
  return {
    id: r.id,
    code: displayNo('R', r.no),
    type: r.type,
    name: r.name,
    last4: r.last4,
    balanceUsdCents: r.balanceUsdCents,
    costPoolCents: r.costPoolCents,
    avgRate:
      r.balanceUsdCents > 0
        ? Math.round((r.costPoolCents / r.balanceUsdCents) * 10000) / 10000
        : null,
    feeBp: r.feeBp,
    feeFixedUsdCents: r.feeFixedUsdCents,
    lowBalanceUsdCents: r.lowBalanceUsdCents,
    low: r.active && r.balanceUsdCents < r.lowBalanceUsdCents,
    active: r.active,
    hasSecretNote: !!r.secretNoteEnc,
    hasCardNumber: !!r.cardNumberEnc,
    holderName: r.holderName,
    remark: r.remark,
    createdAt: r.createdAt,
  };
}

/**
 * 整理卡号：去掉空格和横线。虚拟卡是 12–19 位数字，礼品卡可能带字母，所以只限制成数字和字母。
 * 返回 null 表示没填（清除）。
 */
export function normalizeCardNumber(raw: string): string | null {
  const v = raw.replace(/[\s-]/g, '').toUpperCase();
  if (!v) return null;
  if (!/^[0-9A-Z]{6,30}$/.test(v)) {
    throw badRequest('卡号只能是数字或字母（6–30 位，可以带空格或横线）');
  }
  return v;
}

const stockInclude = {
  plan: { select: { id: true, name: true } },
  customer: { select: customerBriefSelect },
  subscriptions: { where: { status: 'ACTIVE' }, select: { id: true, no: true }, take: 1 },
} satisfies Prisma.ClaudeAccountInclude;
type StockRow = Prisma.ClaudeAccountGetPayload<{ include: typeof stockInclude }>;

function toStockDto(a: StockRow): StockAccountDto {
  const sub = a.subscriptions[0];
  return {
    id: a.id,
    email: a.email,
    plan: a.plan,
    stockStatus: a.stockStatus ?? 'IN_USE',
    stockCostCents: a.stockCostCents,
    upstreamRenewAt: a.upstreamRenewAt,
    stockedAt: a.stockedAt,
    customer: a.customer ? toCustomerBrief(a.customer) : null,
    subscription: sub ? { id: sub.id, code: displayNo('S', sub.no) } : null,
    hasPassword: !!a.passwordEnc,
    hasSecretNote: !!a.secretNoteEnc,
    remark: a.remark,
    createdAt: a.createdAt,
  };
}

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly secrets: SecretBox,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  // ─── 付款资源 ───

  async listResources(): Promise<ResourceDto[]> {
    const rows = await this.prisma.paymentResource.findMany({
      orderBy: [{ active: 'desc' }, { no: 'asc' }],
    });
    return rows.map(toResourceDto);
  }

  async createResource(dto: CreateResourceDto, user: AuthUser): Promise<ResourceDto> {
    if (dto.initialCnyCents !== undefined && dto.initialUsdCents === undefined) {
      throw badRequest('填了入库花费，也要填入库的美元金额');
    }
    const card = dto.cardNumber === undefined ? null : normalizeCardNumber(dto.cardNumber);
    const id = await this.prisma.$transaction(async (tx) => {
      const r = await tx.paymentResource.create({
        data: {
          type: dto.type,
          name: dto.name.trim(),
          last4: card ? card.slice(-4) : dto.last4?.trim() || null,
          cardNumberEnc: card ? this.secrets.encrypt(card) : null,
          holderName: dto.holderName?.trim() || null,
          feeBp: dto.feeBp ?? 0,
          feeFixedUsdCents: dto.feeFixedUsdCents ?? 0,
          lowBalanceUsdCents: dto.lowBalanceUsdCents ?? 0,
          secretNoteEnc: this.secrets.encryptOptional(dto.secretNote),
          remark: dto.remark?.trim() || null,
        },
      });
      if (dto.initialUsdCents) {
        await this.ledger.topUp(tx, r.id, {
          usdCents: dto.initialUsdCents,
          cnyCents: dto.initialCnyCents ?? 0,
          note: '首次入库',
          userId: user.id,
        });
      }
      return r.id;
    });
    return this.getResource(id);
  }

  async updateResource(id: string, dto: UpdateResourceDto): Promise<ResourceDto> {
    await this.getResource(id);
    const card = dto.cardNumber === undefined ? undefined : normalizeCardNumber(dto.cardNumber);
    await this.prisma.paymentResource.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        // 填了完整卡号时后四位跟着卡号走
        last4: card
          ? card.slice(-4)
          : dto.last4 === undefined
            ? undefined
            : dto.last4?.trim() || null,
        cardNumberEnc:
          card === undefined ? undefined : card === null ? null : this.secrets.encrypt(card),
        holderName: dto.holderName === undefined ? undefined : dto.holderName?.trim() || null,
        feeBp: dto.feeBp,
        feeFixedUsdCents: dto.feeFixedUsdCents,
        lowBalanceUsdCents: dto.lowBalanceUsdCents,
        active: dto.active,
        secretNoteEnc:
          dto.secretNote === undefined ? undefined : this.secrets.encryptOptional(dto.secretNote),
        remark: dto.remark === undefined ? undefined : dto.remark?.trim() || null,
      },
    });
    return this.getResource(id);
  }

  async topUp(id: string, dto: TopUpDto, user: AuthUser): Promise<ResourceDto> {
    await this.prisma.$transaction((tx) => this.ledger.topUp(tx, id, { ...dto, userId: user.id }));
    return this.getResource(id);
  }

  async adjust(id: string, dto: AdjustDto, user: AuthUser): Promise<ResourceDto> {
    await this.prisma.$transaction((tx) => this.ledger.adjust(tx, id, { ...dto, userId: user.id }));
    return this.getResource(id);
  }

  async listTransactions(id: string, q: ResourceTxQueryDto): Promise<ResourceTxListDto> {
    await this.getResource(id);
    const where: Prisma.ResourceTransactionWhereInput = { resourceId: id, type: q.type };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.resourceTransaction.findMany({
        where,
        include: {
          user: { select: userBriefSelect },
          costEntry: { select: { order: { select: { id: true, no: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        ...skipTake(q),
      }),
      this.prisma.resourceTransaction.count({ where }),
    ]);
    return {
      items: rows.map((t) => ({
        id: t.id,
        type: t.type,
        usdCents: t.usdCents,
        cnyCents: t.cnyCents,
        balanceAfterUsdCents: t.balanceAfterUsdCents,
        note: t.note,
        order: t.costEntry?.order
          ? { id: t.costEntry.order.id, code: displayNo('D', t.costEntry.order.no) }
          : null,
        user: t.user,
        createdAt: t.createdAt,
      })),
      total,
    };
  }

  async revealResource(id: string, user: AuthUser, req: Request): Promise<ResourceSecretDto> {
    const r = await this.prisma.paymentResource.findUnique({ where: { id } });
    if (!r) throw notFound('付款资源');
    await this.audit.record({
      action: 'resource.secret_view',
      summary: '查看付款资源其他敏感信息',
      userId: user.id,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      resourceId: id,
      detail: { name: r.name },
      ip: req.ip ?? null,
    });
    return {
      name: r.name,
      secretNote: r.secretNoteEnc ? this.secrets.decrypt(r.secretNoteEnc) : null,
    };
  }

  async revealCard(
    id: string,
    q: RevealCardQueryDto,
    user: AuthUser,
    req: Request,
  ): Promise<ResourceCardDto> {
    const r = await this.prisma.paymentResource.findUnique({ where: { id } });
    if (!r) throw notFound('付款资源');
    const order = q.orderId
      ? await this.prisma.order.findUnique({ where: { id: q.orderId }, select: { no: true } })
      : null;
    await this.audit.record({
      action: 'resource.card_view',
      summary: order
        ? `在订单 ${displayNo('D', order.no)} 查看付款卡完整卡号`
        : '查看付款卡完整卡号',
      userId: user.id,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      resourceId: id,
      detail: {
        name: r.name,
        last4: r.last4,
        holderName: r.holderName,
        ...(order ? { order: displayNo('D', order.no) } : {}),
      },
      ip: req.ip ?? null,
    });
    return {
      name: r.name,
      last4: r.last4,
      holderName: r.holderName,
      cardNumber: r.cardNumberEnc ? this.secrets.decrypt(r.cardNumberEnc) : null,
    };
  }

  private async getResource(id: string): Promise<ResourceDto> {
    const r = await this.prisma.paymentResource.findUnique({ where: { id } });
    if (!r) throw notFound('付款资源');
    return toResourceDto(r);
  }

  // ─── 成品号库存 ───

  async listStock(q: StockAccountQueryDto): Promise<StockAccountListDto> {
    const kw = q.keyword?.trim().toLowerCase();
    const where: Prisma.ClaudeAccountWhereInput = {
      ownership: 'COMPANY',
      planId: q.planId,
      stockStatus: q.status,
      email: kw ? { contains: kw } : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.claudeAccount.findMany({
        where,
        include: stockInclude,
        // 在库的先进先出，方便充值员按顺序发号
        orderBy:
          q.status === 'IN_STOCK'
            ? [{ stockedAt: 'asc' }, { createdAt: 'asc' }]
            : [{ updatedAt: 'desc' }],
        ...skipTake(q),
      }),
      this.prisma.claudeAccount.count({ where }),
    ]);
    return { items: rows.map(toStockDto), total };
  }

  async createStock(
    dto: CreateStockAccountsDto,
    user: AuthUser,
  ): Promise<CreateStockAccountsResultDto> {
    const plan = await this.prisma.plan.findUnique({ where: { id: dto.planId } });
    if (!plan) throw notFound('套餐');
    const skipped: SkippedAccountDto[] = [];
    const seen = new Set<string>();
    const fresh: NewStockAccountDto[] = [];
    for (const a of dto.accounts) {
      const email = a.email.trim().toLowerCase();
      if (seen.has(email)) {
        skipped.push({ email, reason: '这次录入里重复了' });
        continue;
      }
      seen.add(email);
      fresh.push({ ...a, email });
    }
    const exists = await this.prisma.claudeAccount.findMany({
      where: { email: { in: fresh.map((a) => a.email) } },
      select: { email: true },
    });
    const existing = new Set(exists.map((e) => e.email));
    const toCreate = fresh.filter((a) => {
      if (existing.has(a.email)) skipped.push({ email: a.email, reason: '系统里已经有这个账号' });
      return !existing.has(a.email);
    });

    const now = new Date();
    await this.prisma.$transaction(
      async (tx) => {
        for (const a of toCreate) {
          const account = await tx.claudeAccount.create({
            data: {
              email: a.email,
              ownership: 'COMPANY',
              stockStatus: 'IN_STOCK',
              planId: plan.id,
              passwordEnc: this.secrets.encrypt(a.password),
              secretNoteEnc: this.secrets.encryptOptional(a.secretNote),
              stockCostCents: dto.costCnyCents ?? 0,
              upstreamRenewAt: dto.upstreamRenewAt
                ? new Date(dto.upstreamRenewAt)
                : dto.resourceId
                  ? addMonths(now, 1)
                  : null,
              stockedAt: now,
              remark: dto.remark?.trim() || null,
            },
          });
          if (dto.resourceId) {
            // 扣费记到这个号上，发号后订单能查到备号时用的哪张卡
            const r = await this.ledger.consume(tx, dto.resourceId, {
              usdCents: dto.chargeUsdCents ?? plan.upstreamMonthlyUsdCents,
              note: `成品号备号：${a.email}`,
              userId: user.id,
              accountId: account.id,
            });
            await tx.claudeAccount.update({
              where: { id: account.id },
              data: { stockCostCents: { increment: r.costCents } },
            });
          }
        }
      },
      { timeout: 60_000 },
    );
    return { created: toCreate.length, skipped };
  }

  async updateStock(id: string, dto: UpdateStockAccountDto): Promise<StockAccountDto> {
    const a = await this.prisma.claudeAccount.findUnique({ where: { id } });
    if (!a || a.ownership !== 'COMPANY') throw notFound('成品号');
    if (dto.stockStatus && a.stockStatus === 'IN_USE') {
      throw badRequest('客户正在使用这个号，不能直接改库存状态；到期回收后再处理');
    }
    if (dto.planId && !(await this.prisma.plan.findUnique({ where: { id: dto.planId } }))) {
      throw notFound('套餐');
    }
    await this.prisma.claudeAccount.update({
      where: { id },
      data: {
        planId: dto.planId,
        stockStatus: dto.stockStatus,
        ...(dto.stockStatus === 'IN_STOCK' && a.stockStatus !== 'IN_STOCK'
          ? { stockedAt: new Date() }
          : {}),
        upstreamRenewAt:
          dto.upstreamRenewAt === undefined
            ? undefined
            : dto.upstreamRenewAt
              ? new Date(dto.upstreamRenewAt)
              : null,
        remark: dto.remark === undefined ? undefined : dto.remark?.trim() || null,
      },
    });
    return this.getStock(id);
  }

  /** 在库成品号的上游扣费（例如在库期间到了扣费日）：成本累计到这个号上，发号时一起结转 */
  async chargeStock(
    id: string,
    dto: ChargeStockAccountDto,
    user: AuthUser,
  ): Promise<StockAccountDto> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ClaudeAccount" WHERE id = ${id} FOR UPDATE`;
      const a = await tx.claudeAccount.findUnique({ where: { id }, include: { plan: true } });
      if (!a || a.ownership !== 'COMPANY') throw notFound('成品号');
      if (a.stockStatus !== 'IN_STOCK') {
        throw badRequest('只有在库的成品号在这里登记扣费；客户使用中的号走内部续费任务');
      }
      if (!a.plan) throw badRequest('先给这个成品号选择套餐');
      const r = await this.ledger.consume(tx, dto.resourceId, {
        usdCents: dto.usdCents ?? a.plan.upstreamMonthlyUsdCents,
        note: `成品号在库续费：${a.email}`,
        userId: user.id,
        accountId: a.id,
      });
      const now = new Date();
      await tx.claudeAccount.update({
        where: { id },
        data: {
          stockCostCents: { increment: r.costCents },
          upstreamRenewAt: dto.upstreamRenewAt
            ? new Date(dto.upstreamRenewAt)
            : addMonths(maxDate(a.upstreamRenewAt ?? now, now), 1),
        },
      });
    });
    return this.getStock(id);
  }

  private async getStock(id: string): Promise<StockAccountDto> {
    const a = await this.prisma.claudeAccount.findUnique({ where: { id }, include: stockInclude });
    if (!a) throw notFound('成品号');
    return toStockDto(a);
  }

  // ─── 汇总与预警 ───

  async summary(): Promise<InventorySummaryDto> {
    const [{ accountStockLow }, plans, groups, resources] = await Promise.all([
      this.settings.getAll(),
      this.prisma.plan.findMany({
        where: { active: true },
        orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.claudeAccount.groupBy({
        by: ['planId', 'stockStatus'],
        where: { ownership: 'COMPANY', stockStatus: { in: ['IN_STOCK', 'IN_USE'] } },
        _count: { _all: true },
      }),
      this.prisma.paymentResource.findMany({ where: { active: true }, orderBy: { no: 'asc' } }),
    ]);
    // 只给已经在卖成品号的套餐做预警
    const accountPlans = new Set(
      (
        await this.prisma.product.findMany({
          where: { fulfillmentType: 'ACCOUNT', active: true },
          select: { planId: true },
        })
      ).map((p) => p.planId),
    );
    const count = (planId: string, status: AccountStockStatus) =>
      groups.find((g) => g.planId === planId && g.stockStatus === status)?._count._all ?? 0;
    const pools = plans
      .filter((p) => accountPlans.has(p.id) || count(p.id, 'IN_STOCK') + count(p.id, 'IN_USE') > 0)
      .map((p) => {
        const inStock = count(p.id, 'IN_STOCK');
        return {
          planId: p.id,
          planName: p.name,
          inStock,
          inUse: count(p.id, 'IN_USE'),
          low: accountPlans.has(p.id) && inStock < accountStockLow,
        };
      });
    const dtos = resources.map(toResourceDto);
    return {
      pools,
      accountStockLow,
      lowResources: dtos.filter((r) => r.low),
      totalBalanceUsdCents: resources.reduce((sum, r) => sum + r.balanceUsdCents, 0),
      totalCostPoolCents: resources.reduce((sum, r) => sum + r.costPoolCents, 0),
    };
  }
}

// ─────────────── Controller ───────────────

@ApiTags('库存与成本')
@ApiBearerAuth()
@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('inventory/summary')
  @RequireAnyPermission('inventory:read', 'fulfillment:handle')
  @ApiOperation({ summary: '库存汇总与预警（成品号按套餐分池、付款资源余额）' })
  @ApiOkResponse({ type: InventorySummaryDto })
  summary(): Promise<InventorySummaryDto> {
    return this.inventory.summary();
  }

  @Get('resources')
  @RequireAnyPermission('inventory:read', 'fulfillment:handle')
  @ApiOperation({ summary: '付款资源列表（充值员完成任务时选择）' })
  @ApiOkResponse({ type: [ResourceDto] })
  listResources(): Promise<ResourceDto[]> {
    return this.inventory.listResources();
  }

  @Post('resources')
  @RequirePermissions('inventory:write')
  @Audit('resource.create', '新增付款资源')
  @ApiOperation({ summary: '新增付款资源（可同时首次入库）' })
  @ApiOkResponse({ type: ResourceDto })
  createResource(
    @Body() dto: CreateResourceDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ResourceDto> {
    return this.inventory.createResource(dto, user);
  }

  @Patch('resources/:id')
  @RequirePermissions('inventory:write')
  @Audit('resource.update', '修改付款资源')
  @ApiOperation({ summary: '修改付款资源（名称、卡号、持卡人、手续费、预警线、停用）' })
  @ApiOkResponse({ type: ResourceDto })
  updateResource(@Param('id') id: string, @Body() dto: UpdateResourceDto): Promise<ResourceDto> {
    return this.inventory.updateResource(id, dto);
  }

  @Post('resources/:id/top-up')
  @HttpCode(200)
  @RequirePermissions('inventory:write')
  @Audit('resource.top_up', '付款资源入库')
  @ApiOperation({ summary: '入库 / 充值：记录美元金额和实际花的人民币' })
  @ApiOkResponse({ type: ResourceDto })
  topUp(
    @Param('id') id: string,
    @Body() dto: TopUpDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ResourceDto> {
    return this.inventory.topUp(id, dto, user);
  }

  @Post('resources/:id/adjust')
  @HttpCode(200)
  @RequirePermissions('inventory:write')
  @Audit('resource.adjust', '付款资源盘点')
  @ApiOperation({ summary: '盘点：把账面余额改成实际余额' })
  @ApiOkResponse({ type: ResourceDto })
  adjust(
    @Param('id') id: string,
    @Body() dto: AdjustDto,
    @CurrentUser() user: AuthUser,
  ): Promise<ResourceDto> {
    return this.inventory.adjust(id, dto, user);
  }

  @Get('resources/:id/transactions')
  @RequirePermissions('inventory:read')
  @ApiOperation({ summary: '付款资源的库存流水' })
  @ApiOkResponse({ type: ResourceTxListDto })
  transactions(
    @Param('id') id: string,
    @Query() q: ResourceTxQueryDto,
  ): Promise<ResourceTxListDto> {
    return this.inventory.listTransactions(id, q);
  }

  @Get('resources/:id/card-number')
  @RequirePermissions('resource:card:view')
  @ApiOperation({ summary: '查看付款卡完整卡号（每次查看都记录操作日志）' })
  @ApiOkResponse({ type: ResourceCardDto })
  revealCard(
    @Param('id') id: string,
    @Query() q: RevealCardQueryDto,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ): Promise<ResourceCardDto> {
    return this.inventory.revealCard(id, q, user, req);
  }

  @Get('resources/:id/secret')
  @RequirePermissions('account:secret:view')
  @ApiOperation({ summary: '查看付款资源的 CVV 等其他敏感信息（每次查看都记录操作日志）' })
  @ApiOkResponse({ type: ResourceSecretDto })
  revealResource(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
  ): Promise<ResourceSecretDto> {
    return this.inventory.revealResource(id, user, req);
  }

  @Get('stock-accounts')
  @RequireAnyPermission('inventory:read', 'fulfillment:handle')
  @ApiOperation({ summary: '成品号库存（在库的按入库时间先进先出）' })
  @ApiOkResponse({ type: StockAccountListDto })
  listStock(@Query() q: StockAccountQueryDto): Promise<StockAccountListDto> {
    return this.inventory.listStock(q);
  }

  @Post('stock-accounts')
  @RequirePermissions('inventory:write')
  @Audit('stock.create', '成品号入库')
  @ApiOperation({ summary: '成品号批量入库（已存在的邮箱自动跳过）' })
  @ApiOkResponse({ type: CreateStockAccountsResultDto })
  createStock(
    @Body() dto: CreateStockAccountsDto,
    @CurrentUser() user: AuthUser,
  ): Promise<CreateStockAccountsResultDto> {
    return this.inventory.createStock(dto, user);
  }

  @Patch('stock-accounts/:id')
  @RequirePermissions('inventory:write')
  @Audit('stock.update', '修改成品号库存')
  @ApiOperation({ summary: '修改成品号的套餐、库存状态（在库 / 作废）、上游付费日' })
  @ApiOkResponse({ type: StockAccountDto })
  updateStock(
    @Param('id') id: string,
    @Body() dto: UpdateStockAccountDto,
  ): Promise<StockAccountDto> {
    return this.inventory.updateStock(id, dto);
  }

  @Post('stock-accounts/:id/charge')
  @HttpCode(200)
  @RequirePermissions('inventory:write')
  @Audit('stock.charge', '登记在库成品号扣费')
  @ApiOperation({ summary: '在库成品号到了上游扣费日：登记扣费，成本累计到这个号上' })
  @ApiOkResponse({ type: StockAccountDto })
  chargeStock(
    @Param('id') id: string,
    @Body() dto: ChargeStockAccountDto,
    @CurrentUser() user: AuthUser,
  ): Promise<StockAccountDto> {
    return this.inventory.chargeStock(id, dto, user);
  }
}

@Module({
  imports: [LedgerModule, SettingsModule],
  providers: [InventoryService],
  controllers: [InventoryController],
  exports: [InventoryService],
})
export class InventoryModule {}
