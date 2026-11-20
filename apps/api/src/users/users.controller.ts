import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthUser } from '../common/auth-user';
import { OkDto } from '../auth/auth.dto';
import { Audit, CurrentUser, RequirePermissions } from '../auth/decorators';
import {
  CreateUserDto,
  ResetPasswordDto,
  UpdateUserDto,
  UserDto,
  UserListDto,
  UserQueryDto,
} from './users.dto';
import { UsersService } from './users.service';

@ApiTags('员工')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions('system:user:read')
  @ApiOperation({ summary: '员工列表' })
  @ApiOkResponse({ type: UserListDto })
  list(@Query() q: UserQueryDto): Promise<UserListDto> {
    return this.users.list(q);
  }

  @Get(':id')
  @RequirePermissions('system:user:read')
  @ApiOperation({ summary: '员工详情' })
  @ApiOkResponse({ type: UserDto })
  get(@Param('id') id: string): Promise<UserDto> {
    return this.users.get(id);
  }

  @Post()
  @RequirePermissions('system:user:write')
  @Audit('user.create', '新增员工')
  @ApiOperation({ summary: '新增员工' })
  @ApiOkResponse({ type: UserDto })
  create(@Body() dto: CreateUserDto): Promise<UserDto> {
    return this.users.create(dto);
  }

  @Patch(':id')
  @RequirePermissions('system:user:write')
  @Audit('user.update', '修改员工')
  @ApiOperation({ summary: '修改员工（姓名、小组、角色、启用/停用）' })
  @ApiOkResponse({ type: UserDto })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: AuthUser,
  ): Promise<UserDto> {
    return this.users.update(id, dto, actor);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  @RequirePermissions('system:user:write')
  @Audit('user.reset_password', '重置员工密码')
  @ApiOperation({ summary: '重置员工密码（员工下次登录需修改）' })
  @ApiOkResponse({ type: OkDto })
  async resetPassword(@Param('id') id: string, @Body() dto: ResetPasswordDto): Promise<OkDto> {
    await this.users.resetPassword(id, dto.password);
    return { ok: true };
  }

  @Delete(':id')
  @RequirePermissions('system:user:write')
  @Audit('user.delete', '删除员工')
  @ApiOperation({ summary: '删除员工（保留历史记录）' })
  @ApiOkResponse({ type: OkDto })
  async remove(@Param('id') id: string, @CurrentUser() actor: AuthUser): Promise<OkDto> {
    await this.users.remove(id, actor);
    return { ok: true };
  }
}
