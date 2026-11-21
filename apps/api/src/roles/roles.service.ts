import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ALL_PERMISSIONS, ALL_PERMISSION_CODES, type DataScope } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { badRequest } from '../common/errors';
import type { CreateRoleDto, RoleDto, UpdateRoleDto } from './roles.dto';

const roleInclude = {
  _count: { select: { users: { where: { user: { deletedAt: null } } } } },
} satisfies Prisma.RoleInclude;

type RoleWithCount = Prisma.RoleGetPayload<{ include: typeof roleInclude }>;

function toDto(r: RoleWithCount): RoleDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    permissions: r.permissions,
    dataScope: r.dataScope as DataScope,
    builtIn: r.builtIn,
    requireTotp: r.requireTotp,
    userCount: r._count.users,
  };
}

/** 自定义角色只能勾选目录里的权限；「全部权限」只留给内置管理员角色 */
function cleanPermissions(perms: string[]): string[] {
  const unique = [...new Set(perms)];
  if (unique.includes(ALL_PERMISSIONS)) {
    throw badRequest('「全部权限」只保留给内置的管理员角色');
  }
  const unknown = unique.filter((p) => !ALL_PERMISSION_CODES.includes(p));
  if (unknown.length > 0) throw badRequest(`不认识的权限：${unknown.join('、')}`);
  return unique.sort();
}

@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<RoleDto[]> {
    const roles = await this.prisma.role.findMany({
      include: roleInclude,
      orderBy: [{ builtIn: 'desc' }, { createdAt: 'asc' }],
    });
    return roles.map(toDto);
  }

  async create(dto: CreateRoleDto): Promise<RoleDto> {
    const exists = await this.prisma.role.findUnique({ where: { code: dto.code } });
    if (exists) throw badRequest('这个角色编码已经存在', 'ROLE_CODE_TAKEN');
    const role = await this.prisma.role.create({
      data: {
        code: dto.code,
        name: dto.name,
        description: dto.description,
        permissions: cleanPermissions(dto.permissions),
        dataScope: dto.dataScope,
        requireTotp: dto.requireTotp ?? false,
      },
      include: roleInclude,
    });
    return toDto(role);
  }

  async update(id: string, dto: UpdateRoleDto): Promise<RoleDto> {
    const role = await this.findOrThrow(id);
    const touchesAccess = dto.permissions !== undefined || dto.dataScope !== undefined;
    if (role.code === 'admin' && touchesAccess) {
      throw badRequest('管理员角色固定拥有全部权限，不能修改');
    }
    const updated = await this.prisma.role.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        permissions: dto.permissions ? cleanPermissions(dto.permissions) : undefined,
        dataScope: dto.dataScope,
        requireTotp: dto.requireTotp,
      },
      include: roleInclude,
    });
    return toDto(updated);
  }

  async remove(id: string): Promise<void> {
    const role = await this.findOrThrow(id);
    if (role.builtIn) throw badRequest('内置角色不能删除，可以修改它的权限');
    if (role._count.users > 0) throw badRequest('还有员工在使用这个角色，请先调整这些员工的角色');
    await this.prisma.role.delete({ where: { id } });
  }

  private async findOrThrow(id: string): Promise<RoleWithCount> {
    const role = await this.prisma.role.findUnique({ where: { id }, include: roleInclude });
    if (!role) throw new NotFoundException({ code: 'NOT_FOUND', message: '角色不存在' });
    return role;
  }
}
