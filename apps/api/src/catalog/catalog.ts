import {
  Body,
  Controller,
  Get,
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
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Prisma } from '@prisma/client';
import {
  FULFILLMENT_TYPES,
  FULFILLMENT_TYPE_LABELS,
  termLabel,
  type FulfillmentType,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { Audit, RequirePermissions } from '../auth/decorators';
import { badRequest, notFound } from '../common/errors';
import { SettingsModule, SettingsService } from '../settings/settings';

// ─────────────── DTO ───────────────

export class PlanDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'MAX' }) code: string;
  @ApiProperty({ example: 'Max' }) name: string;
  @ApiProperty({ description: '官方月费（美分），例如 10000 = $100' })
  upstreamMonthlyUsdCents: number;
  @ApiProperty() sort: number;
  @ApiProperty() active: boolean;
}

export class SavePlanDto {
  @ApiProperty({ example: 'MAX', description: '套餐编码，大写字母、数字或下划线' })
  @Matches(/^[A-Z][A-Z0-9_]{1,31}$/, { message: '编码为 2–32 位大写字母、数字或下划线' })
  code: string;

  @ApiProperty({ example: 'Max' })
  @IsString()
  @IsNotEmpty({ message: '请输入套餐名称' })
  @MaxLength(32)
  name: string;

  @ApiProperty({ description: '官方月费（美分）' })
  @IsInt()
  @Min(0)
  @Max(10_000_00)
  upstreamMonthlyUsdCents: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sort?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdatePlanDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_00)
  upstreamMonthlyUsdCents?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sort?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ProductDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'Max 季付（代充）' }) name: string;
  @ApiProperty() planId: string;
  @ApiProperty() planName: string;
  @ApiProperty({ description: '服务时长（月）' }) termMonths: number;
  @ApiProperty({ enum: FULFILLMENT_TYPES, enumName: 'FulfillmentType' })
  fulfillmentType: FulfillmentType;
  @ApiProperty({ description: '售价（分）' }) priceCents: number;
  @ApiProperty({ description: '按当前汇率估算的上游成本（分），不含付款手续费' })
  estCostCents: number;
  @ApiProperty({ description: '估算毛利（分）= 售价 − 估算成本' }) estMarginCents: number;
  @ApiProperty() active: boolean;
}

export class ProductQueryDto {
  @ApiPropertyOptional({ description: '只看在售商品' })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  activeOnly?: boolean;
}

export class CreateProductDto {
  @ApiProperty()
  @IsString()
  planId: string;

  @ApiProperty({ description: '服务时长（月）', example: 3 })
  @IsInt()
  @Min(1)
  @Max(36)
  termMonths: number;

  @ApiProperty({ enum: FULFILLMENT_TYPES, enumName: 'FulfillmentType' })
  @IsIn(FULFILLMENT_TYPES)
  fulfillmentType: FulfillmentType;

  @ApiProperty({ description: '售价（分）' })
  @IsInt()
  @Min(0)
  @Max(100_000_00)
  priceCents: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateProductDto {
  @ApiPropertyOptional({ description: '售价（分）。只影响之后的订单' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_00)
  priceCents?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

// ─────────────── Service ───────────────

const productInclude = { plan: true } satisfies Prisma.ProductInclude;
type ProductWithPlan = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

export function productName(planName: string, termMonths: number, type: FulfillmentType): string {
  return `${planName} ${termLabel(termMonths)}（${FULFILLMENT_TYPE_LABELS[type]}）`;
}

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async listPlans(): Promise<PlanDto[]> {
    return this.prisma.plan.findMany({ orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }] });
  }

  async createPlan(dto: SavePlanDto): Promise<PlanDto> {
    if (await this.prisma.plan.findUnique({ where: { code: dto.code } })) {
      throw badRequest('这个套餐编码已经存在');
    }
    return this.prisma.plan.create({ data: dto });
  }

  async updatePlan(id: string, dto: UpdatePlanDto): Promise<PlanDto> {
    await this.findPlan(id);
    return this.prisma.plan.update({ where: { id }, data: dto });
  }

  async listProducts(q: ProductQueryDto): Promise<ProductDto[]> {
    const { exchangeRate } = await this.settings.getAll();
    const products = await this.prisma.product.findMany({
      where: q.activeOnly ? { active: true, plan: { active: true } } : {},
      include: productInclude,
      orderBy: [{ plan: { sort: 'asc' } }, { fulfillmentType: 'asc' }, { termMonths: 'asc' }],
    });
    return products.map((p) => this.toProductDto(p, exchangeRate));
  }

  async createProduct(dto: CreateProductDto): Promise<ProductDto> {
    await this.findPlan(dto.planId);
    const exists = await this.prisma.product.findUnique({
      where: {
        planId_termMonths_fulfillmentType: {
          planId: dto.planId,
          termMonths: dto.termMonths,
          fulfillmentType: dto.fulfillmentType,
        },
      },
    });
    if (exists) throw badRequest('同一套餐、时长和履约方式的商品已经存在，直接修改它的售价即可');
    const product = await this.prisma.product.create({ data: dto, include: productInclude });
    const { exchangeRate } = await this.settings.getAll();
    return this.toProductDto(product, exchangeRate);
  }

  async updateProduct(id: string, dto: UpdateProductDto): Promise<ProductDto> {
    if (!(await this.prisma.product.findUnique({ where: { id } }))) throw notFound('商品');
    const product = await this.prisma.product.update({
      where: { id },
      data: dto,
      include: productInclude,
    });
    const { exchangeRate } = await this.settings.getAll();
    return this.toProductDto(product, exchangeRate);
  }

  private async findPlan(id: string) {
    const plan = await this.prisma.plan.findUnique({ where: { id } });
    if (!plan) throw notFound('套餐');
    return plan;
  }

  private toProductDto(p: ProductWithPlan, exchangeRate: number): ProductDto {
    const estCostCents = Math.round(p.plan.upstreamMonthlyUsdCents * p.termMonths * exchangeRate);
    return {
      id: p.id,
      name: productName(p.plan.name, p.termMonths, p.fulfillmentType),
      planId: p.planId,
      planName: p.plan.name,
      termMonths: p.termMonths,
      fulfillmentType: p.fulfillmentType,
      priceCents: p.priceCents,
      estCostCents,
      estMarginCents: p.priceCents - estCostCents,
      active: p.active,
    };
  }
}

// ─────────────── Controller ───────────────

@ApiTags('商品与套餐')
@ApiBearerAuth()
@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('plans')
  @ApiOperation({ summary: '套餐列表（所有员工可查看）' })
  @ApiOkResponse({ type: [PlanDto] })
  listPlans(): Promise<PlanDto[]> {
    return this.catalog.listPlans();
  }

  @Post('plans')
  @RequirePermissions('product:write')
  @Audit('plan.create', '新增套餐')
  @ApiOperation({ summary: '新增套餐' })
  @ApiOkResponse({ type: PlanDto })
  createPlan(@Body() dto: SavePlanDto): Promise<PlanDto> {
    return this.catalog.createPlan(dto);
  }

  @Patch('plans/:id')
  @RequirePermissions('product:write')
  @Audit('plan.update', '修改套餐')
  @ApiOperation({ summary: '修改套餐（名称、官方月费、上下架）' })
  @ApiOkResponse({ type: PlanDto })
  updatePlan(@Param('id') id: string, @Body() dto: UpdatePlanDto): Promise<PlanDto> {
    return this.catalog.updatePlan(id, dto);
  }

  @Get('products')
  @ApiOperation({ summary: '商品列表（所有员工可查看，下单时选择）' })
  @ApiOkResponse({ type: [ProductDto] })
  listProducts(@Query() q: ProductQueryDto): Promise<ProductDto[]> {
    return this.catalog.listProducts(q);
  }

  @Post('products')
  @RequirePermissions('product:write')
  @Audit('product.create', '新增商品')
  @ApiOperation({ summary: '新增商品（套餐 × 时长 × 履约方式）' })
  @ApiOkResponse({ type: ProductDto })
  createProduct(@Body() dto: CreateProductDto): Promise<ProductDto> {
    return this.catalog.createProduct(dto);
  }

  @Patch('products/:id')
  @RequirePermissions('product:write')
  @Audit('product.update', '修改商品售价或上下架')
  @ApiOperation({ summary: '修改商品售价或上下架（只影响之后的订单）' })
  @ApiOkResponse({ type: ProductDto })
  updateProduct(@Param('id') id: string, @Body() dto: UpdateProductDto): Promise<ProductDto> {
    return this.catalog.updateProduct(id, dto);
  }
}

@Module({
  imports: [SettingsModule],
  providers: [CatalogService],
  controllers: [CatalogController],
  exports: [CatalogService],
})
export class CatalogModule {}
