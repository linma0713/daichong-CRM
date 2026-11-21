import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import type { Response } from 'express';
import {
  ATTACHMENT_EXTENSIONS,
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_PER_OWNER,
  ATTACHMENT_OWNER_LABELS,
  ATTACHMENT_OWNER_TYPES,
  ErrorCode,
  hasPermission,
  sniffMimeType,
  type AttachmentOwnerType,
} from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { Audit, CurrentUser } from '../auth/decorators';
import type { AuthUser } from '../common/auth-user';
import { UserBriefDto, userBriefSelect } from '../common/briefs';
import { badRequest, notFound } from '../common/errors';
import { OkDto } from '../auth/auth.dto';
import { visibleOrders } from '../orders/orders';
import { visibleRefunds, visibleTickets } from '../aftersales/aftersales';
import { visibleCustomers } from '../customers/customers';
import { COMMISSION_VIEW_PERMISSIONS } from '../commissions/commissions';
import { FileStorage } from './storage';

// ─────────────── DTO ───────────────

export class AttachmentOwnerQueryDto {
  @ApiProperty({ enum: ATTACHMENT_OWNER_TYPES })
  @IsIn(ATTACHMENT_OWNER_TYPES)
  ownerType: AttachmentOwnerType;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  ownerId: string;
}

export class AttachmentDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ATTACHMENT_OWNER_TYPES }) ownerType: string;
  @ApiProperty() ownerId: string;
  @ApiProperty() fileName: string;
  @ApiProperty({ example: 'image/png' }) mimeType: string;
  @ApiProperty({ description: '字节数' }) size: number;
  @ApiProperty({ type: UserBriefDto }) uploadedBy: UserBriefDto;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ description: '当前员工能不能删（上传的人或管理员）' }) canDelete: boolean;
}

/** multer 解析出来的上传文件（只用到这几个字段） */
interface UploadedFileLike {
  buffer: Buffer;
  size: number;
  originalname: string;
}

// ─────────────── 权限：附件跟着所属的业务走 ───────────────

interface OwnerRule {
  /** 能看这类业务的权限（任意一个） */
  read: readonly string[];
  /** 能上传附件的权限（任意一个） */
  write: readonly string[];
  /** 业务存在，并且在当前员工的数据范围内 */
  visible: (prisma: PrismaService, user: AuthUser, id: string) => Promise<boolean>;
}

const RULES: Record<AttachmentOwnerType, OwnerRule> = {
  order: {
    read: ['order:read'],
    write: ['order:write', 'payment:confirm'],
    visible: async (p, u, id) =>
      (await p.order.count({ where: { AND: [{ id }, visibleOrders(u)] } })) > 0,
  },
  ticket: {
    read: ['ticket:create', 'ticket:handle'],
    write: ['ticket:create', 'ticket:handle'],
    visible: async (p, u, id) =>
      (await p.ticket.count({ where: { AND: [{ id }, visibleTickets(u)] } })) > 0,
  },
  refund: {
    read: ['refund:approve', 'ticket:handle', 'finance:read'],
    write: ['refund:approve', 'ticket:handle'],
    visible: async (p, u, id) =>
      (await p.refund.count({ where: { AND: [{ id }, visibleRefunds(u)] } })) > 0,
  },
  customer: {
    read: ['customer:read'],
    write: ['customer:write'],
    visible: async (p, u, id) =>
      (await p.customer.count({ where: { AND: [{ id }, visibleCustomers(u)] } })) > 0,
  },
  statement: {
    read: COMMISSION_VIEW_PERMISSIONS,
    write: ['commission:settle'],
    visible: async (p, _u, id) => (await p.commissionStatement.count({ where: { id } })) > 0,
  },
};

const can = (user: AuthUser, codes: readonly string[]) =>
  codes.some((c) => hasPermission(user.permissions, c));
const isAdmin = (user: AuthUser) => hasPermission(user.permissions, '*');

function forbidden(message: string) {
  return new ForbiddenException({ code: ErrorCode.FORBIDDEN, message });
}

/** 文件名只留来显示：去掉路径和控制字符，限制长度 */
function cleanFileName(name: string, ext: string): string {
  // multer 按 latin1 解析文件名，中文文件名要转回 UTF-8
  let decoded = name;
  try {
    decoded = Buffer.from(name, 'latin1').toString('utf8');
    if (decoded.includes('�')) decoded = name;
  } catch {
    decoded = name;
  }
  const base = decoded
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 120);
  return base || `附件.${ext}`;
}

// ─────────────── Service ───────────────

const include = { uploadedBy: { select: userBriefSelect } } as const;

@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: FileStorage,
  ) {}

  async list(q: AttachmentOwnerQueryDto, user: AuthUser): Promise<AttachmentDto[]> {
    await this.assertAccess(q.ownerType, q.ownerId, user, 'read');
    const rows = await this.prisma.attachment.findMany({
      where: { ownerType: q.ownerType, ownerId: q.ownerId },
      include,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.toDto(r, user));
  }

  async upload(
    q: AttachmentOwnerQueryDto,
    file: UploadedFileLike | undefined,
    user: AuthUser,
  ): Promise<AttachmentDto> {
    if (!file || !file.buffer?.length) throw badRequest('请选择要上传的文件');
    if (file.size > ATTACHMENT_MAX_BYTES) throw badRequest('文件不能超过 10 MB');
    await this.assertAccess(q.ownerType, q.ownerId, user, 'write');
    const mimeType = sniffMimeType(file.buffer.subarray(0, 16));
    if (!mimeType) throw badRequest('只能上传图片（PNG、JPG、GIF、WEBP）或 PDF');
    const count = await this.prisma.attachment.count({
      where: { ownerType: q.ownerType, ownerId: q.ownerId },
    });
    if (count >= ATTACHMENT_MAX_PER_OWNER) {
      throw badRequest(
        `每条${ATTACHMENT_OWNER_LABELS[q.ownerType]}最多 ${ATTACHMENT_MAX_PER_OWNER} 个附件`,
      );
    }
    const ext = ATTACHMENT_EXTENSIONS[mimeType];
    const storageKey = this.storage.newKey(ext);
    await this.storage.put(storageKey, file.buffer);
    try {
      const row = await this.prisma.attachment.create({
        data: {
          ownerType: q.ownerType,
          ownerId: q.ownerId,
          fileName: cleanFileName(file.originalname, ext),
          mimeType,
          size: file.size,
          storageKey,
          uploadedById: user.id,
        },
        include,
      });
      return this.toDto(row, user);
    } catch (err) {
      await this.storage.remove(storageKey);
      throw err;
    }
  }

  async open(id: string, user: AuthUser) {
    const row = await this.find(id);
    await this.assertAccess(row.ownerType as AttachmentOwnerType, row.ownerId, user, 'read');
    if (!(await this.storage.exists(row.storageKey))) {
      throw notFound('附件文件（可能是迁移服务器时没有拷贝 uploads 目录）');
    }
    return { row, stream: this.storage.read(row.storageKey) };
  }

  async remove(id: string, user: AuthUser): Promise<void> {
    const row = await this.find(id);
    await this.assertAccess(row.ownerType as AttachmentOwnerType, row.ownerId, user, 'read');
    if (!this.canDelete(row, user)) throw forbidden('只有上传的人或管理员可以删除附件');
    await this.prisma.attachment.delete({ where: { id } });
    await this.storage.remove(row.storageKey);
  }

  private canDelete(row: { uploadedById: string; ownerType: string }, user: AuthUser): boolean {
    if (isAdmin(user)) return true;
    const rule = RULES[row.ownerType as AttachmentOwnerType];
    return row.uploadedById === user.id && !!rule && can(user, rule.write);
  }

  private async find(id: string) {
    const row = await this.prisma.attachment.findUnique({ where: { id } });
    if (!row) throw notFound('附件');
    return row;
  }

  private async assertAccess(
    type: AttachmentOwnerType,
    ownerId: string,
    user: AuthUser,
    mode: 'read' | 'write',
  ): Promise<void> {
    const rule = RULES[type];
    if (!rule || !can(user, rule.read)) throw notFound(ATTACHMENT_OWNER_LABELS[type] ?? '附件');
    if (!(await rule.visible(this.prisma, user, ownerId))) {
      throw notFound(ATTACHMENT_OWNER_LABELS[type]);
    }
    if (mode === 'write' && !can(user, rule.write)) {
      throw forbidden(`你没有给${ATTACHMENT_OWNER_LABELS[type]}上传附件的权限`);
    }
  }

  private toDto(
    r: {
      id: string;
      ownerType: string;
      ownerId: string;
      fileName: string;
      mimeType: string;
      size: number;
      uploadedById: string;
      uploadedBy: UserBriefDto;
      createdAt: Date;
    },
    user: AuthUser,
  ): AttachmentDto {
    return {
      id: r.id,
      ownerType: r.ownerType,
      ownerId: r.ownerId,
      fileName: r.fileName,
      mimeType: r.mimeType,
      size: r.size,
      uploadedBy: r.uploadedBy,
      createdAt: r.createdAt,
      canDelete: this.canDelete(r, user),
    };
  }
}

// ─────────────── Controller ───────────────

@ApiTags('附件')
@ApiBearerAuth()
@Controller('attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get()
  @ApiOperation({ summary: '某条业务（订单、工单、退款、客户、对账单）的附件' })
  @ApiOkResponse({ type: [AttachmentDto] })
  list(
    @Query() q: AttachmentOwnerQueryDto,
    @CurrentUser() user: AuthUser,
  ): Promise<AttachmentDto[]> {
    return this.attachments.list(q, user);
  }

  @Post()
  @Audit('attachment.upload', '上传附件')
  @UseInterceptors(
    // 不设 storage 时 multer 把文件放在内存里（10 MB 以内）
    FileInterceptor('file', {
      // 多给 1 字节，超出时在业务里给中文提示
      limits: { fileSize: ATTACHMENT_MAX_BYTES + 1, files: 1 },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['ownerType', 'ownerId', 'file'],
      properties: {
        ownerType: { type: 'string', enum: ATTACHMENT_OWNER_TYPES },
        ownerId: { type: 'string' },
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiOperation({ summary: '上传附件（图片或 PDF，10 MB 以内）' })
  @ApiOkResponse({ type: AttachmentDto })
  upload(
    @Body() q: AttachmentOwnerQueryDto,
    @UploadedFile() file: UploadedFileLike | undefined,
    @CurrentUser() user: AuthUser,
  ): Promise<AttachmentDto> {
    return this.attachments.upload(q, file, user);
  }

  @Get(':id/file')
  @ApiOperation({ summary: '下载 / 预览附件文件' })
  async file(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { row, stream } = await this.attachments.open(id, user);
    const image = row.mimeType.startsWith('image/');
    res.set({
      'Content-Type': row.mimeType,
      'Content-Length': String(row.size),
      'Content-Disposition': `${image ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.fileName)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, max-age=86400',
    });
    return new StreamableFile(stream);
  }

  @Delete(':id')
  @Audit('attachment.delete', '删除附件')
  @ApiOperation({ summary: '删除附件（上传的人或管理员）' })
  @ApiOkResponse({ type: OkDto })
  async remove(@Param('id') id: string, @CurrentUser() user: AuthUser): Promise<OkDto> {
    await this.attachments.remove(id, user);
    return { ok: true };
  }
}

@Module({
  providers: [AttachmentsService, FileStorage],
  controllers: [AttachmentsController],
})
export class AttachmentsModule {}
