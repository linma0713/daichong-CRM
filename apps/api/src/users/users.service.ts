import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { ALL_PERMISSIONS, ErrorCode } from '@crm/shared';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/auth-user';
import { badRequest } from '../common/errors';
import { skipTake } from '../common/pagination';
import type { CreateUserDto, UpdateUserDto, UserDto, UserListDto, UserQueryDto } from './users.dto';

const userInclude = {
  team: { select: { id: true, name: true } },
  roles: { include: { role: { select: { id: true, code: true, name: true } } } },
} satisfies Prisma.UserInclude;

type UserWithRelations = Prisma.UserGetPayload<{ include: typeof userInclude }>;

function toDto(u: UserWithRelations): UserDto {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    status: u.status,
    mustChangePassword: u.mustChangePassword,
    team: u.team,
    roles: u.roles.map((r) => r.role),
    lastLoginAt: u.lastLoginAt,
    createdAt: u.createdAt,
  };
}

/**
 * 管理员账号只能由管理员处理：否则有「新增 / 编辑员工」权限的人
 * 可以重置管理员密码或给自己加管理员角色，从而拿到全部权限。
 */
function assertActorIsAdmin(actor: AuthUser, what: string): void {
  if (!actor.permissions.includes(ALL_PERMISSIONS)) {
    throw new ForbiddenException({ code: ErrorCode.FORBIDDEN, message: `只有管理员可以${what}` });
  }
}

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: UserQueryDto): Promise<UserListDto> {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      status: q.status,
      teamId: q.teamId,
      roles: q.roleId ? { some: { roleId: q.roleId } } : undefined,
      OR: q.keyword
        ? [
            { username: { contains: q.keyword, mode: 'insensitive' } },
            { displayName: { contains: q.keyword, mode: 'insensitive' } },
          ]
        : undefined,
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        include: userInclude,
        orderBy: { createdAt: 'asc' },
        ...skipTake(q),
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items: items.map(toDto), total };
  }

  async get(id: string): Promise<UserDto> {
    return toDto(await this.findOrThrow(id));
  }

  async create(dto: CreateUserDto, actor: AuthUser): Promise<UserDto> {
    const exists = await this.prisma.user.findUnique({ where: { username: dto.username } });
    if (exists) throw badRequest('这个用户名已经被使用', 'USERNAME_TAKEN');
    await this.assertRolesExist(dto.roleIds);
    if (await this.rolesGrantAll(dto.roleIds)) assertActorIsAdmin(actor, '授予管理员角色');
    await this.assertTeamExists(dto.teamId);
    const user = await this.prisma.user.create({
      data: {
        username: dto.username,
        displayName: dto.displayName,
        passwordHash: await bcrypt.hash(dto.password, 10),
        mustChangePassword: true,
        teamId: dto.teamId ?? null,
        roles: { create: dto.roleIds.map((roleId) => ({ roleId })) },
      },
      include: userInclude,
    });
    return toDto(user);
  }

  async update(id: string, dto: UpdateUserDto, actor: AuthUser): Promise<UserDto> {
    await this.findOrThrow(id);
    if (dto.status === 'DISABLED' && id === actor.id) throw badRequest('不能停用自己的账号');
    if (await this.isAdmin(id)) assertActorIsAdmin(actor, '修改管理员账号');
    if (dto.roleIds) {
      await this.assertRolesExist(dto.roleIds);
      if (await this.rolesGrantAll(dto.roleIds)) assertActorIsAdmin(actor, '授予管理员角色');
    }
    if (dto.teamId !== undefined) await this.assertTeamExists(dto.teamId);

    const losesAdmin =
      dto.status === 'DISABLED' ||
      (dto.roleIds !== undefined && !(await this.rolesGrantAll(dto.roleIds)));
    if (losesAdmin && (await this.isAdmin(id))) await this.assertAnotherAdminRemains(id);

    const ops: Prisma.PrismaPromise<unknown>[] = [];
    if (dto.roleIds) {
      ops.push(this.prisma.userRole.deleteMany({ where: { userId: id } }));
      ops.push(
        this.prisma.userRole.createMany({
          data: dto.roleIds.map((roleId) => ({ userId: id, roleId })),
        }),
      );
    }
    ops.push(
      this.prisma.user.update({
        where: { id },
        data: { displayName: dto.displayName, teamId: dto.teamId, status: dto.status },
      }),
    );
    if (dto.status === 'DISABLED') ops.push(this.revokeSessions(id));
    await this.prisma.$transaction(ops);
    return this.get(id);
  }

  async resetPassword(id: string, password: string, actor: AuthUser): Promise<void> {
    await this.findOrThrow(id);
    if (await this.isAdmin(id)) assertActorIsAdmin(actor, '重置管理员的密码');
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id },
        data: { passwordHash: await bcrypt.hash(password, 10), mustChangePassword: true },
      }),
      this.revokeSessions(id),
    ]);
  }

  /** 删除员工：软删除，保留历史记录，立即踢下线 */
  async remove(id: string, actor: AuthUser): Promise<void> {
    await this.findOrThrow(id);
    if (id === actor.id) throw badRequest('不能删除自己的账号');
    if (await this.isAdmin(id)) {
      assertActorIsAdmin(actor, '删除管理员账号');
      await this.assertAnotherAdminRemains(id);
    }
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id },
        data: { deletedAt: new Date(), status: 'DISABLED' },
      }),
      this.revokeSessions(id),
    ]);
  }

  private async findOrThrow(id: string): Promise<UserWithRelations> {
    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      include: userInclude,
    });
    if (!user) throw new NotFoundException({ code: 'NOT_FOUND', message: '员工不存在' });
    return user;
  }

  private revokeSessions(userId: string) {
    return this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private async assertRolesExist(roleIds: string[]): Promise<void> {
    const unique = [...new Set(roleIds)];
    const count = await this.prisma.role.count({ where: { id: { in: unique } } });
    if (count !== unique.length) throw badRequest('选择的角色不存在');
  }

  private async assertTeamExists(teamId: string | null | undefined): Promise<void> {
    if (!teamId) return;
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw badRequest('选择的小组不存在');
  }

  private async rolesGrantAll(roleIds: string[]): Promise<boolean> {
    const n = await this.prisma.role.count({
      where: { id: { in: roleIds }, permissions: { has: ALL_PERMISSIONS } },
    });
    return n > 0;
  }

  private async isAdmin(userId: string): Promise<boolean> {
    const n = await this.prisma.userRole.count({
      where: { userId, role: { permissions: { has: ALL_PERMISSIONS } } },
    });
    return n > 0;
  }

  /** 防止把最后一个管理员停用、删除或降权，导致没人能管理系统 */
  private async assertAnotherAdminRemains(userId: string): Promise<void> {
    const others = await this.prisma.user.count({
      where: {
        id: { not: userId },
        deletedAt: null,
        status: 'ACTIVE',
        roles: { some: { role: { permissions: { has: ALL_PERMISSIONS } } } },
      },
    });
    if (others === 0) throw badRequest('至少要保留一个可用的管理员账号', 'LAST_ADMIN');
  }
}
