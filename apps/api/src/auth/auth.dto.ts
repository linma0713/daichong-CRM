import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { DATA_SCOPES, PASSWORD_RULE, type DataScope } from '@crm/shared';

export class LoginDto {
  @ApiProperty({ example: 'admin' })
  @IsString()
  @IsNotEmpty({ message: '请输入用户名' })
  @MaxLength(64)
  username: string;

  @ApiProperty({ example: 'Admin@123456' })
  @IsString()
  @IsNotEmpty({ message: '请输入密码' })
  @MaxLength(128)
  password: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty({ message: '请输入原密码' })
  oldPassword: string;

  @ApiProperty({ description: PASSWORD_RULE.message })
  @IsString()
  @Matches(PASSWORD_RULE.pattern, { message: PASSWORD_RULE.message })
  newPassword: string;
}

export class RoleBriefDto {
  @ApiProperty() id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
}

export class ProfileDto {
  @ApiProperty() id: string;
  @ApiProperty() username: string;
  @ApiProperty() displayName: string;
  @ApiProperty({ type: String, nullable: true }) teamId: string | null;
  @ApiProperty({ type: [RoleBriefDto] }) roles: RoleBriefDto[];
  @ApiProperty({ type: [String], description: '权限码，* 表示全部权限' }) permissions: string[];
  @ApiProperty({ enum: DATA_SCOPES, enumName: 'DataScope' }) dataScope: DataScope;
  @ApiProperty({ description: '是否需要先修改初始密码' }) mustChangePassword: boolean;
}

export class TokenPairDto {
  @ApiProperty() accessToken: string;
  @ApiProperty() refreshToken: string;
}

export class LoginResponseDto extends TokenPairDto {
  @ApiProperty({ type: ProfileDto }) user: ProfileDto;
}

export class OkDto {
  @ApiProperty({ example: true }) ok: boolean;
}
