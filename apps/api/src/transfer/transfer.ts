import { Body, Controller, Get, HttpCode, Injectable, Module, Post, Query } from '@nestjs/common';
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
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { isEmail } from 'class-validator';
import type { Prisma } from '@prisma/client';
import { CUSTOMER_SOURCES, displayNo, type CustomerSource } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser, RequirePermissions, SkipAudit } from '../auth/decorators';
import type { AuthUser } from '../common/auth-user';
import { AuditService } from '../audit/audit.service';
import {
  CONTACT_FIELDS,
  CustomerDto,
  CustomerQueryDto,
  CustomersModule,
  CustomersService,
  assertCanAssign,
} from '../customers/customers';
import { OrderDto, OrderQueryDto, OrdersModule, OrdersService } from '../orders/orders';

/** 一次最多导入多少行、导出多少条 */
export const IMPORT_MAX_ROWS = 500;
export const EXPORT_MAX_ROWS = 5000;

// ─────────────── DTO ───────────────

/** 表格里的一行，全是文字；在服务里逐行校验，好告诉员工具体哪一行哪里不对 */
export class ImportCustomerRowDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) wechat?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) telegram?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) email?: string;
  @ApiPropertyOptional({ description: '来源：中文名或英文值，不填为自然流量' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  source?: string;
  @ApiPropertyOptional({ description: '渠道名称' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  channel?: string;
  @ApiPropertyOptional({ description: '标签，用逗号、顿号或空格隔开' })
  @IsOptional()
  @IsString()
  @MaxLength(400)
  tags?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) remark?: string;
  @ApiPropertyOptional({ description: '负责人：员工姓名或登录名，不填为自己' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  owner?: string;
  @ApiPropertyOptional({ description: '这一行在表格里的行号，提示里用它；不传按第几行数据算' })
  @IsOptional()
  @IsInt()
  @Min(1)
  line?: number;
}

export class ImportCustomersDto {
  @ApiProperty({ type: [ImportCustomerRowDto] })
  @IsArray()
  @ArrayMinSize(1, { message: '表格里没有数据' })
  @ArrayMaxSize(IMPORT_MAX_ROWS, { message: `一次最多导入 ${IMPORT_MAX_ROWS} 行，请分批导入` })
  @ValidateNested({ each: true })
  @Type(() => ImportCustomerRowDto)
  rows: ImportCustomerRowDto[];

  @ApiPropertyOptional({ description: 'true 只检查不导入' })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class ImportRowResultDto {
  @ApiProperty({ description: '表格行号（传了 line 用 line，否则是第几行数据）' }) row: number;
  @ApiProperty() name: string;
  @ApiProperty({ enum: ['ok', 'error'] }) status: 'ok' | 'error';
  @ApiProperty({ type: [String] }) errors: string[];
  @ApiProperty({ type: String, nullable: true, description: '负责人姓名' }) ownerName:
    string | null;
}

export class ImportResultDto {
  @ApiProperty() total: number;
  @ApiProperty({ description: '可以导入的行数' }) valid: number;
  @ApiProperty({ description: '实际新建的客户数（只检查时为 0）' }) created: number;
  @ApiProperty({ type: [ImportRowResultDto] }) rows: ImportRowResultDto[];
}

export class CustomerExportDto {
  @ApiProperty({ type: [CustomerDto] }) items: CustomerDto[];
  @ApiProperty() total: number;
  @ApiProperty({ description: `超过 ${EXPORT_MAX_ROWS} 条时只导出前 ${EXPORT_MAX_ROWS} 条` })
  truncated: boolean;
}

export class OrderExportDto {
  @ApiProperty({ type: [OrderDto] }) items: OrderDto[];
  @ApiProperty() total: number;
  @ApiProperty() truncated: boolean;
}

// ─────────────── 导入客户 ───────────────

const SOURCE_BY_TEXT = new Map<string, CustomerSource>(
  CUSTOMER_SOURCES.flatMap((s) => [
    [s.label, s.value],
    [s.value, s.value],
  ]),
);
SOURCE_BY_TEXT.set('推荐', 'referral');
SOURCE_BY_TEXT.set('转介绍', 'referral');
SOURCE_BY_TEXT.set('广告', 'ads');
SOURCE_BY_TEXT.set('自然', 'organic');

const FIELD_LIMITS = { wechat: 64, telegram: 64, phone: 32, email: 120 } as const;
type ContactField = (typeof CONTACT_FIELDS)[number][0];

interface ParsedRow {
  name: string;
  wechat: string | null;
  telegram: string | null;
  phone: string | null;
  email: string | null;
  source: CustomerSource;
  channelId: string | null;
  tags: string[];
  remark: string | null;
  owner: { id: string; teamId: string | null; displayName: string };
}

@Injectable()
export class CustomerImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async run(dto: ImportCustomersDto, user: AuthUser): Promise<ImportResultDto> {
    const [channels, staff, me] = await Promise.all([
      this.prisma.channel.findMany(),
      this.prisma.user.findMany({
        where: { deletedAt: null, status: 'ACTIVE' },
        select: { id: true, username: true, displayName: true, teamId: true },
      }),
      this.prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { id: true, teamId: true, displayName: true },
      }),
    ]);
    const channelByName = new Map(channels.map((c) => [c.name.toLowerCase(), c]));

    const results: ImportRowResultDto[] = [];
    const parsed: (ParsedRow | null)[] = [];
    /** 文件内部查重：值 → 第几行 */
    const seen = new Map<string, number>();

    dto.rows.forEach((raw, i) => {
      const rowNo = raw.line ?? i + 1;
      const errors: string[] = [];
      const t = (v?: string) => v?.replace(/\s+/g, ' ').trim() ?? '';
      const name = t(raw.name);
      if (!name) errors.push('缺少称呼');
      else if (name.length > 32) errors.push('称呼最多 32 个字');

      const contacts = {
        wechat: t(raw.wechat) || null,
        telegram: t(raw.telegram) || null,
        phone: t(raw.phone) || null,
        email: t(raw.email).toLowerCase() || null,
      };
      if (!contacts.wechat && !contacts.telegram && !contacts.phone && !contacts.email) {
        errors.push('微信、Telegram、手机、邮箱至少填一个');
      }
      for (const [field, label] of CONTACT_FIELDS) {
        const v = contacts[field];
        if (!v) continue;
        if (v.length > FIELD_LIMITS[field]) errors.push(`${label}太长`);
        const key = `${field}:${v.toLowerCase()}`;
        const first = seen.get(key);
        if (first) errors.push(`${label}和第 ${first} 行重复`);
        else seen.set(key, rowNo);
      }
      if (contacts.email && !isEmail(contacts.email)) errors.push('邮箱格式不正确');

      const sourceText = t(raw.source);
      const source = sourceText ? SOURCE_BY_TEXT.get(sourceText.toLowerCase()) : 'organic';
      if (!source) {
        errors.push(`来源只能填：${CUSTOMER_SOURCES.map((s) => s.label).join('、')}`);
      }

      let channelId: string | null = null;
      const channelText = t(raw.channel);
      if (channelText) {
        const c = channelByName.get(channelText.toLowerCase());
        if (!c) errors.push(`渠道「${channelText}」不存在，先在「渠道与营销」里新增`);
        else if (!c.enabled) errors.push(`渠道「${channelText}」已停用`);
        else channelId = c.id;
      }

      const tags = [
        ...new Set(
          t(raw.tags)
            .split(/[,，、;；\s]+/)
            .map((x) => x.trim())
            .filter(Boolean),
        ),
      ];
      if (tags.length > 10) errors.push('标签最多 10 个');
      if (tags.some((x) => x.length > 16)) errors.push('每个标签最多 16 个字');
      const remark = t(raw.remark) || null;
      if (remark && remark.length > 500) errors.push('备注最多 500 字');

      let owner: ParsedRow['owner'] = me;
      const ownerText = t(raw.owner);
      if (ownerText) {
        const byUsername = staff.filter(
          (s) => s.username.toLowerCase() === ownerText.toLowerCase(),
        );
        const byName = staff.filter((s) => s.displayName === ownerText);
        const match = byUsername.length === 1 ? byUsername : byName;
        if (match.length === 0) errors.push(`负责人「${ownerText}」不存在或已停用`);
        else if (match.length > 1)
          errors.push(`有 ${match.length} 个员工叫「${ownerText}」，请填登录名`);
        else {
          try {
            assertCanAssign(user, match[0]);
            owner = match[0];
          } catch {
            errors.push(`你不能把客户分配给「${ownerText}」`);
          }
        }
      }

      results.push({
        row: rowNo,
        name: name || '—',
        status: errors.length ? 'error' : 'ok',
        errors,
        ownerName: owner.displayName,
      });
      parsed.push(
        errors.length
          ? null
          : {
              name,
              ...contacts,
              source: source!,
              channelId,
              tags,
              remark,
              owner,
            },
      );
    });

    await this.markExisting(parsed, results);

    const valid = parsed.filter((p): p is ParsedRow => p !== null);
    let created = 0;
    if (!dto.dryRun && valid.length > 0) {
      const res = await this.prisma.customer.createMany({
        data: valid.map((p) => ({
          name: p.name,
          wechat: p.wechat,
          telegram: p.telegram,
          phone: p.phone,
          email: p.email,
          source: p.source,
          channelId: p.channelId,
          tags: p.tags,
          remark: p.remark,
          ownerId: p.owner.id,
          teamId: p.owner.teamId,
        })),
      });
      created = res.count;
      await this.audit.record({
        action: 'customer.import',
        summary: '批量导入客户',
        userId: user.id,
        method: 'POST',
        path: '/api/customers/import',
        detail: { total: dto.rows.length, created, skipped: dto.rows.length - created },
      });
    }
    return { total: dto.rows.length, valid: valid.length, created, rows: results };
  }

  /** 和系统里已有客户的联系方式查重，重复的行标成错误 */
  private async markExisting(parsed: (ParsedRow | null)[], results: ImportRowResultDto[]) {
    const or: Prisma.CustomerWhereInput[] = [];
    for (const [field] of CONTACT_FIELDS) {
      const values = [...new Set(parsed.map((p) => p?.[field]).filter((v): v is string => !!v))];
      for (const v of values) or.push({ [field]: { equals: v, mode: 'insensitive' } });
    }
    if (or.length === 0) return;
    const existing = await this.prisma.customer.findMany({
      where: { deletedAt: null, OR: or },
      select: {
        no: true,
        wechat: true,
        telegram: true,
        phone: true,
        email: true,
        owner: { select: { displayName: true } },
      },
    });
    const index = new Map<string, (typeof existing)[number]>();
    for (const c of existing) {
      for (const [field] of CONTACT_FIELDS) {
        const v = c[field as ContactField];
        if (v) index.set(`${field}:${v.toLowerCase()}`, c);
      }
    }
    parsed.forEach((p, i) => {
      if (!p) return;
      for (const [field, label] of CONTACT_FIELDS) {
        const v = p[field];
        const dup = v ? index.get(`${field}:${v.toLowerCase()}`) : undefined;
        if (dup) {
          results[i].errors.push(
            `${label}已经是客户 ${displayNo('C', dup.no)} 的了（负责人：${dup.owner.displayName}）`,
          );
        }
      }
      if (results[i].errors.length) {
        results[i].status = 'error';
        parsed[i] = null;
      }
    });
  }
}

// ─────────────── 导出 ───────────────

@Injectable()
export class ExportService {
  constructor(
    private readonly customers: CustomersService,
    private readonly orders: OrdersService,
    private readonly audit: AuditService,
  ) {}

  async customersExport(q: CustomerQueryDto, user: AuthUser): Promise<CustomerExportDto> {
    const { page: _p, pageSize: _s, ...filters } = q;
    const res = await this.customers.list(
      { ...filters, page: 1, pageSize: EXPORT_MAX_ROWS } as CustomerQueryDto,
      user,
    );
    await this.audit.record({
      action: 'customer.export',
      summary: '导出客户清单',
      userId: user.id,
      method: 'GET',
      path: '/api/exports/customers',
      detail: { filters, count: res.items.length },
    });
    return { items: res.items, total: res.total, truncated: res.total > res.items.length };
  }

  async ordersExport(q: OrderQueryDto, user: AuthUser): Promise<OrderExportDto> {
    const { page: _p, pageSize: _s, ...filters } = q;
    const res = await this.orders.list(
      { ...filters, page: 1, pageSize: EXPORT_MAX_ROWS } as OrderQueryDto,
      user,
    );
    await this.audit.record({
      action: 'order.export',
      summary: '导出订单清单',
      userId: user.id,
      method: 'GET',
      path: '/api/exports/orders',
      detail: { filters, count: res.items.length },
    });
    return { items: res.items, total: res.total, truncated: res.total > res.items.length };
  }
}

// ─────────────── Controller ───────────────

@ApiTags('客户')
@ApiBearerAuth()
@Controller('customers')
export class CustomerImportController {
  constructor(private readonly importer: CustomerImportService) {}

  @Post('import')
  @HttpCode(200)
  @RequirePermissions('customer:write')
  // 行数据可能很多，不整个写进操作日志；导入成功时在服务里单独记一条
  @SkipAudit()
  @ApiOperation({
    summary: `批量导入客户（一次最多 ${IMPORT_MAX_ROWS} 行）。dryRun=true 只检查；正式导入时有问题的行会跳过`,
  })
  @ApiOkResponse({ type: ImportResultDto })
  import(@Body() dto: ImportCustomersDto, @CurrentUser() user: AuthUser): Promise<ImportResultDto> {
    return this.importer.run(dto, user);
  }
}

@ApiTags('导出')
@ApiBearerAuth()
@Controller('exports')
export class ExportsController {
  constructor(private readonly exports: ExportService) {}

  @Get('customers')
  @RequirePermissions('customer:read', 'customer:export')
  @ApiOperation({
    summary: `导出客户清单（筛选条件同客户列表，最多 ${EXPORT_MAX_ROWS} 条，记日志）`,
  })
  @ApiOkResponse({ type: CustomerExportDto })
  customers(@Query() q: CustomerQueryDto, @CurrentUser() user: AuthUser) {
    return this.exports.customersExport(q, user);
  }

  @Get('orders')
  @RequirePermissions('order:read', 'order:export')
  @ApiOperation({
    summary: `导出订单清单（筛选条件同订单列表，最多 ${EXPORT_MAX_ROWS} 条，记日志）`,
  })
  @ApiOkResponse({ type: OrderExportDto })
  orders(@Query() q: OrderQueryDto, @CurrentUser() user: AuthUser) {
    return this.exports.ordersExport(q, user);
  }
}

@Module({
  imports: [CustomersModule, OrdersModule],
  providers: [CustomerImportService, ExportService],
  controllers: [CustomerImportController, ExportsController],
})
export class TransferModule {}
