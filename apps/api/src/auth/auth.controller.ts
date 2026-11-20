import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { AuthUser } from '../common/auth-user';
import { requestMeta } from '../common/request-meta';
import {
  ChangePasswordDto,
  LoginDto,
  LoginResponseDto,
  OkDto,
  ProfileDto,
  RefreshDto,
  TokenPairDto,
} from './auth.dto';
import { AuthService, toProfile } from './auth.service';
import { AllowPendingPasswordChange, Audit, CurrentUser, Public, SkipAudit } from './decorators';

@ApiTags('登录')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @SkipAudit()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: '员工登录' })
  @ApiOkResponse({ type: LoginResponseDto })
  login(@Body() dto: LoginDto, @Req() req: Request): Promise<LoginResponseDto> {
    return this.auth.login(dto.username, dto.password, requestMeta(req));
  }

  @Public()
  @SkipAudit()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: '刷新登录令牌' })
  @ApiOkResponse({ type: TokenPairDto })
  refresh(@Body() dto: RefreshDto, @Req() req: Request): Promise<TokenPairDto> {
    return this.auth.refresh(dto.refreshToken, requestMeta(req));
  }

  @ApiBearerAuth()
  @AllowPendingPasswordChange()
  @Audit('auth.logout', '退出登录')
  @Post('logout')
  @HttpCode(200)
  @ApiOperation({ summary: '退出登录' })
  @ApiOkResponse({ type: OkDto })
  async logout(@CurrentUser() user: AuthUser): Promise<OkDto> {
    await this.auth.logout(user.sessionId);
    return { ok: true };
  }

  @ApiBearerAuth()
  @AllowPendingPasswordChange()
  @Get('me')
  @ApiOperation({ summary: '当前登录员工的信息和权限' })
  @ApiOkResponse({ type: ProfileDto })
  me(@CurrentUser() user: AuthUser): ProfileDto {
    return toProfile(user);
  }

  @ApiBearerAuth()
  @AllowPendingPasswordChange()
  @Audit('auth.change_password', '修改自己的密码')
  @Post('change-password')
  @HttpCode(200)
  @ApiOperation({ summary: '修改自己的密码' })
  @ApiOkResponse({ type: OkDto })
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<OkDto> {
    await this.auth.changePassword(user, dto.oldPassword, dto.newPassword);
    return { ok: true };
  }
}
