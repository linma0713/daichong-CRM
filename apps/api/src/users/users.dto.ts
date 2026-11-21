import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { PASSWORD_RULE } from '@crm/shared';
import { PageQueryDto } from '../common/pagination';
import { RoleBriefDto } from '../auth/auth.dto';

export const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export type UserStatusValue = (typeof USER_STATUSES)[number];

export class UserQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: '按用户名或姓名搜索' })
  @IsOptional()
  @IsString()
  keyword?: string;

  @ApiPropertyOptional({ enum: USER_STATUSES, enumName: 'UserStatus' })
  @IsOptional()
  @IsIn(USER_STATUSES)
  status?: UserStatusValue;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  teamId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  roleId?: string;
}

export class CreateUserDto {
  @ApiProperty({
    example: 'zhangsan',
    description: '登录用户名，3–32 位字母、数字、下划线、点或横线',
  })
  @Matches(/^[A-Za-z0-9_.-]{3,32}$/, { message: '用户名为 3–32 位字母、数字、下划线、点或横线' })
  username: string;

  @ApiProperty({ example: '张三' })
  @IsString()
  @IsNotEmpty({ message: '请输入姓名' })
  @MaxLength(32)
  displayName: string;

  @ApiProperty({ description: `初始密码。${PASSWORD_RULE.message}；员工首次登录需修改` })
  @Matches(PASSWORD_RULE.pattern, { message: PASSWORD_RULE.message })
  password: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  teamId?: string | null;

  @ApiProperty({ type: [String], description: '角色 ID，可以多选' })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  roleIds: string[];
}

export class UpdateUserDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  displayName?: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: '传 null 表示移出小组' })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  teamId?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  roleIds?: string[];

  @ApiPropertyOptional({ enum: USER_STATUSES, enumName: 'UserStatus' })
  @IsOptional()
  @IsIn(USER_STATUSES)
  status?: UserStatusValue;
}

export class ResetPasswordDto {
  @ApiProperty({ description: `新的初始密码。${PASSWORD_RULE.message}` })
  @Matches(PASSWORD_RULE.pattern, { message: PASSWORD_RULE.message })
  password: string;
}

export class TeamBriefDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
}

export class UserDto {
  @ApiProperty() id: string;
  @ApiProperty() username: string;
  @ApiProperty() displayName: string;
  @ApiProperty({ enum: USER_STATUSES, enumName: 'UserStatus' }) status: UserStatusValue;
  @ApiProperty() mustChangePassword: boolean;
  @ApiProperty({ type: TeamBriefDto, nullable: true }) team: TeamBriefDto | null;
  @ApiProperty({ type: [RoleBriefDto] }) roles: RoleBriefDto[];
  @ApiProperty({ type: Date, nullable: true }) lastLoginAt: Date | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ description: '已开启两步验证' }) totpEnabled: boolean;
  @ApiProperty({ type: Date, nullable: true, description: '输错太多次锁定到这个时间' })
  lockedUntil: Date | null;
}

export class UserListDto {
  @ApiProperty({ type: [UserDto] }) items: UserDto[];
  @ApiProperty() total: number;
}
