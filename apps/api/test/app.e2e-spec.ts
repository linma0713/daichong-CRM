import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { ErrorCode } from '@crm/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { runSeed } from '../prisma/seed';

const ADMIN = { username: 'admin', password: 'Admin@123456' };
const ADMIN_NEW_PASSWORD = 'NewAdmin2026';

describe('M0 底座接口', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const http = () => request(app.getHttpServer());

  /** 登录后的管理员令牌，在用例之间传递 */
  let adminToken = '';
  let adminRefresh = '';
  let adminId = '';
  let salesRoleId = '';
  let teamId = '';
  let staffId = '';
  let staffToken = '';

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditLog", "Session", "UserRole", "User", "Role", "Team" RESTART IDENTITY CASCADE',
    );
    await runSeed(prisma, { adminUsername: ADMIN.username, adminPassword: ADMIN.password });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('健康检查不需要登录', async () => {
    const res = await http().get('/api/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', database: 'up' });
  });

  it('未登录访问业务接口返回 401', async () => {
    await http().get('/api/users').expect(401);
  });

  it('密码错误返回 401，并记录登录失败日志', async () => {
    const res = await http()
      .post('/api/auth/login')
      .send({ username: ADMIN.username, password: 'wrong-password1' })
      .expect(401);
    expect(res.body.code).toBe(ErrorCode.INVALID_CREDENTIALS);
    const failed = await prisma.auditLog.count({ where: { action: 'auth.login_failed' } });
    expect(failed).toBe(1);
  });

  it('首次登录成功，但必须先改初始密码', async () => {
    const res = await http().post('/api/auth/login').send(ADMIN).expect(200);
    expect(res.body.user.mustChangePassword).toBe(true);
    expect(res.body.user.permissions).toEqual(['*']);
    expect(res.body.user.dataScope).toBe('ALL');
    adminToken = res.body.accessToken;
    adminRefresh = res.body.refreshToken;
    adminId = res.body.user.id;

    // 能看自己的信息
    await http().get('/api/auth/me').auth(adminToken, { type: 'bearer' }).expect(200);
    // 其他接口被拦住
    const blocked = await http().get('/api/users').auth(adminToken, { type: 'bearer' }).expect(403);
    expect(blocked.body.code).toBe(ErrorCode.PASSWORD_CHANGE_REQUIRED);
  });

  it('修改密码：弱密码被拒绝，改完后可以正常使用', async () => {
    await http()
      .post('/api/auth/change-password')
      .auth(adminToken, { type: 'bearer' })
      .send({ oldPassword: ADMIN.password, newPassword: '12345678' })
      .expect(400);
    await http()
      .post('/api/auth/change-password')
      .auth(adminToken, { type: 'bearer' })
      .send({ oldPassword: 'not-the-old-one1', newPassword: ADMIN_NEW_PASSWORD })
      .expect(400);
    await http()
      .post('/api/auth/change-password')
      .auth(adminToken, { type: 'bearer' })
      .send({ oldPassword: ADMIN.password, newPassword: ADMIN_NEW_PASSWORD })
      .expect(200);

    const me = await http().get('/api/auth/me').auth(adminToken, { type: 'bearer' }).expect(200);
    expect(me.body.mustChangePassword).toBe(false);
    const users = await http().get('/api/users').auth(adminToken, { type: 'bearer' }).expect(200);
    expect(users.body.total).toBe(1);
  });

  it('刷新令牌会轮换，旧的刷新令牌不能再用', async () => {
    const res = await http()
      .post('/api/auth/refresh')
      .send({ refreshToken: adminRefresh })
      .expect(200);
    expect(res.body.refreshToken).not.toBe(adminRefresh);
    await http().post('/api/auth/refresh').send({ refreshToken: adminRefresh }).expect(401);
    adminToken = res.body.accessToken;
    adminRefresh = res.body.refreshToken;
    await http().get('/api/auth/me').auth(adminToken, { type: 'bearer' }).expect(200);
  });

  it('权限目录和内置角色', async () => {
    const catalog = await http()
      .get('/api/permissions')
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(catalog.body.groups.length).toBeGreaterThan(0);
    expect(catalog.body.dataScopes.map((d: { value: string }) => d.value)).toEqual([
      'SELF',
      'TEAM',
      'ALL',
    ]);

    const roles = await http().get('/api/roles').auth(adminToken, { type: 'bearer' }).expect(200);
    const codes = roles.body.map((r: { code: string }) => r.code);
    expect(codes).toEqual(expect.arrayContaining(['admin', 'sales', 'fulfillment', 'finance']));
    salesRoleId = roles.body.find((r: { code: string }) => r.code === 'sales').id;
  });

  it('角色：不能授予全部权限或未知权限，内置角色不能删，管理员权限不能改', async () => {
    const auth = { type: 'bearer' } as const;
    await http()
      .post('/api/roles')
      .auth(adminToken, auth)
      .send({ code: 'boss', name: '老板', permissions: ['*'], dataScope: 'ALL' })
      .expect(400);
    await http()
      .post('/api/roles')
      .auth(adminToken, auth)
      .send({ code: 'boss', name: '老板', permissions: ['no:such:perm'], dataScope: 'ALL' })
      .expect(400);
    const created = await http()
      .post('/api/roles')
      .auth(adminToken, auth)
      .send({
        code: 'viewer',
        name: '只读',
        permissions: ['system:user:read', 'system:audit:read'],
        dataScope: 'TEAM',
      })
      .expect(201);
    expect(created.body.permissions).toEqual(['system:audit:read', 'system:user:read']);

    const roles = await http().get('/api/roles').auth(adminToken, auth).expect(200);
    const adminRole = roles.body.find((r: { code: string }) => r.code === 'admin');
    await http()
      .patch(`/api/roles/${adminRole.id}`)
      .auth(adminToken, auth)
      .send({ permissions: ['system:user:read'] })
      .expect(400);
    await http().delete(`/api/roles/${salesRoleId}`).auth(adminToken, auth).expect(400);
    await http().delete(`/api/roles/${created.body.id}`).auth(adminToken, auth).expect(200);
  });

  it('新增小组和员工；用户名不能重复', async () => {
    const auth = { type: 'bearer' } as const;
    const team = await http()
      .post('/api/teams')
      .auth(adminToken, auth)
      .send({ name: '客服一组' })
      .expect(201);
    teamId = team.body.id;

    const staff = await http()
      .post('/api/users')
      .auth(adminToken, auth)
      .send({
        username: 'kefu01',
        displayName: '客服小王',
        password: 'Kefu2026init',
        teamId,
        roleIds: [salesRoleId],
      })
      .expect(201);
    staffId = staff.body.id;
    expect(staff.body.mustChangePassword).toBe(true);
    expect(staff.body.team).toEqual({ id: teamId, name: '客服一组' });

    const dup = await http()
      .post('/api/users')
      .auth(adminToken, auth)
      .send({ username: 'kefu01', displayName: '重复', password: 'Kefu2026init', roleIds: [] })
      .expect(400);
    expect(dup.body.code).toBe('USERNAME_TAKEN');

    const teams = await http().get('/api/teams').auth(adminToken, auth).expect(200);
    expect(teams.body).toEqual([{ id: teamId, name: '客服一组', userCount: 1 }]);
    // 有员工的小组不能删
    await http().delete(`/api/teams/${teamId}`).auth(adminToken, auth).expect(400);
  });

  it('客服登录后只能做自己权限内的事', async () => {
    const auth = { type: 'bearer' } as const;
    const login = await http()
      .post('/api/auth/login')
      .send({ username: 'kefu01', password: 'Kefu2026init' })
      .expect(200);
    staffToken = login.body.accessToken;
    expect(login.body.user.dataScope).toBe('SELF');
    await http()
      .post('/api/auth/change-password')
      .auth(staffToken, auth)
      .send({ oldPassword: 'Kefu2026init', newPassword: 'Kefu2026mine' })
      .expect(200);

    const denied = await http().get('/api/users').auth(staffToken, auth).expect(403);
    expect(denied.body.code).toBe(ErrorCode.FORBIDDEN);
    await http().get('/api/audit-logs').auth(staffToken, auth).expect(403);
    // 角色列表：查看角色或查看员工的权限有其一即可，客服两者都没有
    await http().get('/api/roles').auth(staffToken, auth).expect(403);
  });

  it('不能停用、删除自己，也不能把最后一个管理员降权', async () => {
    const auth = { type: 'bearer' } as const;
    await http()
      .patch(`/api/users/${adminId}`)
      .auth(adminToken, auth)
      .send({ status: 'DISABLED' })
      .expect(400);
    await http().delete(`/api/users/${adminId}`).auth(adminToken, auth).expect(400);
    const demote = await http()
      .patch(`/api/users/${adminId}`)
      .auth(adminToken, auth)
      .send({ roleIds: [salesRoleId] })
      .expect(400);
    expect(demote.body.code).toBe('LAST_ADMIN');
  });

  it('停用员工后，其已登录的设备立即失效，也不能再登录', async () => {
    const auth = { type: 'bearer' } as const;
    await http()
      .patch(`/api/users/${staffId}`)
      .auth(adminToken, auth)
      .send({ status: 'DISABLED' })
      .expect(200);
    await http().get('/api/auth/me').auth(staffToken, auth).expect(401);
    const login = await http()
      .post('/api/auth/login')
      .send({ username: 'kefu01', password: 'Kefu2026mine' })
      .expect(403);
    expect(login.body.code).toBe(ErrorCode.ACCOUNT_DISABLED);
  });

  it('操作日志记录了写操作，且密码已脱敏', async () => {
    const res = await http()
      .get('/api/audit-logs')
      .query({ action: 'user.create', pageSize: 10 })
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(res.body.total).toBe(1);
    const log = res.body.items[0];
    expect(log.user.username).toBe('admin');
    expect(log.resourceId).toBe(staffId);
    expect(log.detail.username).toBe('kefu01');
    expect(log.detail.password).toBe('***');

    const all = await http()
      .get('/api/audit-logs')
      .query({ pageSize: 100 })
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    const actions = all.body.items.map((l: { action: string }) => l.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'auth.login',
        'auth.login_failed',
        'auth.change_password',
        'role.create',
        'team.create',
        'user.update',
      ]),
    );
    const changePwd = all.body.items.find(
      (l: { action: string }) => l.action === 'auth.change_password',
    );
    expect(changePwd.detail).toEqual({ oldPassword: '***', newPassword: '***' });
  });

  it('退出登录后令牌立即失效', async () => {
    const auth = { type: 'bearer' } as const;
    await http().post('/api/auth/logout').auth(adminToken, auth).expect(200);
    await http().get('/api/auth/me').auth(adminToken, auth).expect(401);
    await http().post('/api/auth/refresh').send({ refreshToken: adminRefresh }).expect(401);
  });
});
