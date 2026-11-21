import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { DATA_SCOPES, type DataScope } from '@crm/shared';

export class CreateRoleDto {
  @ApiProperty({ example: 'senior_sales', description: '角色编码，小写字母开头，可含数字和下划线' })
  @Matches(/^[a-z][a-z0-9_]{1,31}$/, { message: '编码为 2–32 位小写字母、数字或下划线，字母开头' })
  code: string;

  @ApiProperty({ example: '资深客服' })
  @IsString()
  @IsNotEmpty({ message: '请输入角色名称' })
  @MaxLength(32)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  permissions: string[];

  @ApiProperty({ enum: DATA_SCOPES, enumName: 'DataScope' })
  @IsIn(DATA_SCOPES)
  dataScope: DataScope;

  @ApiPropertyOptional({ description: '这个角色的员工必须开启两步验证' })
  @IsOptional()
  @IsBoolean()
  requireTotp?: boolean;
}

export class UpdateRoleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  permissions?: string[];

  @ApiPropertyOptional({ enum: DATA_SCOPES, enumName: 'DataScope' })
  @IsOptional()
  @IsIn(DATA_SCOPES)
  dataScope?: DataScope;

  @ApiPropertyOptional({ description: '这个角色的员工必须开启两步验证' })
  @IsOptional()
  @IsBoolean()
  requireTotp?: boolean;
}

export class RoleDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty({ type: String, nullable: true }) description: string | null;
  @ApiProperty({ type: [String] }) permissions: string[];
  @ApiProperty({ enum: DATA_SCOPES, enumName: 'DataScope' }) dataScope: DataScope;
  @ApiProperty({ description: '内置角色不能删除' }) builtIn: boolean;
  @ApiProperty({ description: '这个角色的员工必须开启两步验证' }) requireTotp: boolean;
  @ApiProperty({ description: '有多少员工使用这个角色' }) userCount: number;
}

export class PermissionItemDto {
  @ApiProperty() code: string;
  @ApiProperty() name: string;
}

export class PermissionGroupDto {
  @ApiProperty() key: string;
  @ApiProperty() name: string;
  @ApiProperty({ description: '当前版本是否已有对应功能' }) available: boolean;
  @ApiProperty({ type: [PermissionItemDto] }) permissions: PermissionItemDto[];
}

export class DataScopeOptionDto {
  @ApiProperty({ enum: DATA_SCOPES, enumName: 'DataScope' }) value: DataScope;
  @ApiProperty() label: string;
}

export class PermissionCatalogDto {
  @ApiProperty({ type: [PermissionGroupDto] }) groups: PermissionGroupDto[];
  @ApiProperty({ type: [DataScopeOptionDto] }) dataScopes: DataScopeOptionDto[];
}
