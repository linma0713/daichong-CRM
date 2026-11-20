import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DATA_SCOPES, DATA_SCOPE_LABELS, PERMISSION_GROUPS } from '@crm/shared';
import { OkDto } from '../auth/auth.dto';
import { Audit, RequireAnyPermission, RequirePermissions } from '../auth/decorators';
import { CreateRoleDto, PermissionCatalogDto, RoleDto, UpdateRoleDto } from './roles.dto';
import { RolesService } from './roles.service';

@ApiTags('角色与权限')
@ApiBearerAuth()
@Controller()
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  @Get('permissions')
  @RequirePermissions('system:role:read')
  @ApiOperation({ summary: '权限目录和数据范围选项' })
  @ApiOkResponse({ type: PermissionCatalogDto })
  catalog(): PermissionCatalogDto {
    return {
      groups: PERMISSION_GROUPS,
      dataScopes: DATA_SCOPES.map((value) => ({ value, label: DATA_SCOPE_LABELS[value] })),
    };
  }

  @Get('roles')
  @RequireAnyPermission('system:role:read', 'system:user:read')
  @ApiOperation({ summary: '角色列表（查看角色或查看员工的权限均可）' })
  @ApiOkResponse({ type: [RoleDto] })
  list(): Promise<RoleDto[]> {
    return this.roles.list();
  }

  @Post('roles')
  @RequirePermissions('system:role:write')
  @Audit('role.create', '新增角色')
  @ApiOperation({ summary: '新增角色' })
  @ApiOkResponse({ type: RoleDto })
  create(@Body() dto: CreateRoleDto): Promise<RoleDto> {
    return this.roles.create(dto);
  }

  @Patch('roles/:id')
  @RequirePermissions('system:role:write')
  @Audit('role.update', '修改角色权限')
  @ApiOperation({ summary: '修改角色' })
  @ApiOkResponse({ type: RoleDto })
  update(@Param('id') id: string, @Body() dto: UpdateRoleDto): Promise<RoleDto> {
    return this.roles.update(id, dto);
  }

  @Delete('roles/:id')
  @RequirePermissions('system:role:write')
  @Audit('role.delete', '删除角色')
  @ApiOperation({ summary: '删除角色' })
  @ApiOkResponse({ type: OkDto })
  async remove(@Param('id') id: string): Promise<OkDto> {
    await this.roles.remove(id);
    return { ok: true };
  }
}
