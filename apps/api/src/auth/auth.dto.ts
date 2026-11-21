import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
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

  @ApiPropertyOptional({ description: '浏览器生成的设备编号，用来判断是不是新设备登录' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/)
  deviceId?: string;
}

export class LoginTotpDto {
  @ApiProperty({ description: '第一步登录返回的 challenge' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  challenge: string;

  @ApiProperty({ description: '验证器里的 6 位数字，或者一个恢复码（xxxx-xxxx）' })
  @IsString()
  @IsNotEmpty({ message: '请输入验证码' })
  @MaxLength(20)
  code: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,64}$/)
  deviceId?: string;
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
  @ApiProperty({ description: '已开启两步验证' }) totpEnabled: boolean;
  @ApiProperty({ description: '角色要求两步验证但还没开，需要先设置' }) mustSetupTotp: boolean;
}

export class TokenPairDto {
  @ApiProperty() accessToken: string;
  @ApiProperty() refreshToken: string;
}

/** 没开两步验证：直接返回令牌；开了：返回 challenge，再调 /auth/login/totp */
export class LoginResponseDto {
  @ApiProperty({ description: '需要输入两步验证码' }) totpRequired: boolean;
  @ApiPropertyOptional({ description: '两步验证用的中间令牌，5 分钟内有效' }) challenge?: string;
  @ApiPropertyOptional() accessToken?: string;
  @ApiPropertyOptional() refreshToken?: string;
  @ApiPropertyOptional({ type: ProfileDto }) user?: ProfileDto;
}

export class OkDto {
  @ApiProperty({ example: true }) ok: boolean;
}
