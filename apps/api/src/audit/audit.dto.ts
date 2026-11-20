import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsString } from 'class-validator';
import { PageQueryDto } from '../common/pagination';

export class AuditQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '只看某个员工' })
  @IsOptional()
  @IsString()
  userId?: string;

  @ApiPropertyOptional({ description: '动作，例如 user.create' })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ description: '开始时间（ISO 格式）' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: '结束时间（ISO 格式）' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class AuditUserDto {
  @ApiProperty() id: string;
  @ApiProperty() username: string;
  @ApiProperty() displayName: string;
}

export class AuditLogDto {
  @ApiProperty() id: string;
  @ApiProperty() action: string;
  @ApiProperty() summary: string;
  @ApiProperty({ type: AuditUserDto, nullable: true }) user: AuditUserDto | null;
  @ApiProperty({ type: String, nullable: true }) method: string | null;
  @ApiProperty({ type: String, nullable: true }) path: string | null;
  @ApiProperty({ type: String, nullable: true }) resourceId: string | null;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: '请求内容（已脱敏）',
  })
  detail: unknown;
  @ApiProperty({ type: String, nullable: true }) ip: string | null;
  @ApiProperty() createdAt: Date;
}

export class AuditLogListDto {
  @ApiProperty({ type: [AuditLogDto] }) items: AuditLogDto[];
  @ApiProperty() total: number;
}
