import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { runSeed } from '../prisma/seed';
import { totpCode, totpStep } from '../src/auth/totp';

const PASSWORD = 'Crm2026test';
const CHROME_WIN =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const WECHAT_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50';

/**
 * M4 第五批：登录安全（输错锁定、两步验证、登录设备、新设备提醒）
 */
describe('M4 登录安全', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let ipSeq = 0;
  /** 每个请求换一个来源 IP，免得撞上登录频率限制 */
  const http = () => request(app.getHttpServer());
  const nextIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
  const login = (username: string, password = PASSWORD, extra: object = {}, ua = CHROME_WIN) =>
    http()
      .post('/api/auth/login')
      .set('X-Forwarded-For', nextIp())
      .set('User-Agent', ua)
      .send({ username, password, ...extra });
  const loginTotp = (challenge: string, code: string, extra: object = {}, ua = CHROME_WIN) =>
    http()
      .post('/api/auth/login/totp')
      .set('X-Forwarded-For', nextIp())
      .set('User-Agent', ua)
      .send({ challenge, code, ...extra });
  const as = (token: string) => ({
    get: (url: string) => http().get(`/api${url}`).auth(token, { type: 'bearer' }),
    post: (url: string, body: object = {}) =>
      http().post(`/api${url}`).auth(token, { type: 'bearer' }).send(body),
    patch: (url: string, body: object = {}) =>
      http().patch(`/api${url}`).auth(token, { type: 'bearer' }).send(body),
    delete: (url: string) => http().delete(`/api${url}`).auth(token, { type: 'bearer' }),
  });
  const ids: Record<string, string> = {};
  let adminToken = '';

  async function createStaff(username: string, displayName: string, roleCode: string) {
    const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
    const user = await prisma.user.create({
      data: {
        username,
        displayName,
        passwordHash: await bcrypt.hash(PASSWORD, 4),
        mustChangePassword: false,
        roles: { create: [{ roleId: role.id }] },
      },
    });
    ids[username] = user.id;
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "AuditLog", "Session", "UserRole", "User", "Role", "Team", "Customer",
        "FollowUp", "Plan", "Product", "Order", "Payment", "ClaudeAccount", "Subscription",
        "FulfillmentTask", "Setting", "PaymentResource", "ResourceTransaction", "CostEntry",
        "Ticket", "TicketEvent", "Refund", "Agent", "Commission", "CommissionStatement",
        "Notification", "NotifyChannel", "OutboundMessage", "ScriptTemplate", "Channel",
        "ChannelCost", "ReferralReward", "Attachment"
        RESTART IDENTITY CASCADE`);
    await runSeed(prisma, { adminUsername: 'admin', adminPassword: PASSWORD });
    await prisma.user.updateMany({ data: { mustChangePassword: false } });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    adminToken = (await login('admin').expect(200)).body.accessToken;
    await createStaff('sales', '客服小王', 'sales');
    await createStaff('finance', '财务小陈', 'finance');
    await createStaff('zhang', '充值员小张', 'fulfillment');
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('输错锁定', () => {
    it('连续输错 5 次锁 15 分钟，提醒本人和管理员；管理员可以解锁', async () => {
      for (let i = 0; i < 4; i++) {
        const r = await login('zhang', 'wrong-pass-1').expect(401);
        expect(r.body.code).toBe('INVALID_CREDENTIALS');
      }
      const fifth = await login('zhang', 'wrong-pass-1').expect(403);
      expect(fifth.body).toMatchObject({ code: 'ACCOUNT_LOCKED' });
      expect(fifth.body.message).toContain('连续输错 5 次');
      // 锁定期间密码对了也进不去
      await login('zhang').expect(403);

      const notices = await prisma.notification.findMany({ where: { event: 'security.locked' } });
      expect(notices.map((n) => n.userId).sort()).toEqual([ids.zhang, await adminId()].sort());
      expect(notices[0].title).toContain('充值员小张（zhang）的账号因连续输错被锁定 15 分钟');
      expect(await prisma.auditLog.count({ where: { action: 'auth.locked' } })).toBe(1);

      const list = await as(adminToken).get('/users?keyword=zhang').expect(200);
      expect(list.body.items[0].lockedUntil).not.toBeNull();
      await as(adminToken).post(`/users/${ids.zhang}/unlock`).expect(200);
      await login('zhang').expect(200);
      const u = await prisma.user.findUniqueOrThrow({ where: { id: ids.zhang } });
      expect(u).toMatchObject({ failedLogins: 0, lockedUntil: null });
    });

    it('登录成功会把输错次数清零', async () => {
      await login('zhang', 'wrong-pass-2').expect(401);
      await login('zhang', 'wrong-pass-2').expect(401);
      await login('zhang').expect(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.zhang } })).failedLogins).toBe(
        0,
      );
    });

    it('管理员重置密码会顺便解锁', async () => {
      await createStaff('wu', '客服小吴', 'sales');
      for (let i = 0; i < 5; i++) await login('wu', 'wrong-pass-3');
      await login('wu').expect(403);
      await as(adminToken)
        .post(`/users/${ids.wu}/reset-password`, { password: 'NewPass2026x' })
        .expect(200);
      const r = await login('wu', 'NewPass2026x').expect(200);
      expect(r.body.user.mustChangePassword).toBe(true);
    });
  });

  describe('两步验证', () => {
    let token = '';
    let secret = '';
    let recovery: string[] = [];

    it('扫码 → 输验证码开启，返回 8 个恢复码；日志里不记验证码', async () => {
      token = (await login('sales').expect(200)).body.accessToken;
      const st = await as(token).get('/auth/totp').expect(200);
      expect(st.body).toMatchObject({ enabled: false, required: false });

      const setup = await as(token).post('/auth/totp/setup').expect(200);
      secret = setup.body.secret;
      expect(setup.body.otpauthUrl).toContain(`secret=${secret}`);
      expect(setup.body.otpauthUrl).toContain('sales');
      // 还没开启时再打开（或者同时打开两次）拿到的是同一个密钥
      const again = await Promise.all([
        as(token).post('/auth/totp/setup').expect(200),
        as(token).post('/auth/totp/setup').expect(200),
      ]);
      expect(again.map((r) => r.body.secret)).toEqual([secret, secret]);
      await as(token).post('/auth/totp/enable', { code: '000000' }).expect(400);
      const en = await as(token)
        .post('/auth/totp/enable', { code: totpCode(secret, totpStep()) })
        .expect(200);
      recovery = en.body.recoveryCodes;
      expect(recovery).toHaveLength(8);
      await as(token).post('/auth/totp/setup').expect(400);

      const me = await as(token).get('/auth/me').expect(200);
      expect(me.body).toMatchObject({ totpEnabled: true, mustSetupTotp: false });
      const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'auth.totp_enable' } });
      expect(JSON.stringify(log)).not.toContain(totpCode(secret, totpStep()));
      const stored = await prisma.user.findUniqueOrThrow({ where: { id: ids.sales } });
      expect(stored.totpSecret).not.toContain(secret);
    });

    it('登录要两步：密码对了先拿到 challenge，再输验证码；同一个码不能用两次', async () => {
      const first = await login('sales').expect(200);
      expect(first.body).toMatchObject({ totpRequired: true });
      expect(first.body.accessToken).toBeUndefined();
      const challenge = first.body.challenge as string;
      // challenge 不能当登录令牌用
      await as(challenge).get('/auth/me').expect(401);
      // 登录令牌也不能当 challenge 用；过期或伪造的提示重新输密码
      for (const fake of [token, 'not-a-token']) {
        const r = await loginTotp(fake, '123456').expect(401);
        expect(r.body.code).toBe('TOTP_CHALLENGE_EXPIRED');
      }

      const bad = await loginTotp(challenge, '123456').expect(401);
      expect(bad.body.code).toBe('TOTP_INVALID');
      // 开启时用掉的是当前时间片，验证器下一个码（30 秒后）也认
      const next = totpCode(secret, totpStep() + 1);
      const ok = await loginTotp(challenge, next).expect(200);
      expect(ok.body).toMatchObject({ totpRequired: false, user: { username: 'sales' } });
      expect(ok.body.accessToken).toBeTruthy();
      await loginTotp(challenge, next).expect(401);
      await loginTotp('not-a-token', next).expect(401);
      const log = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'auth.login', userId: ids.sales },
        orderBy: { createdAt: 'desc' },
      });
      expect(log.detail).toMatchObject({ method: 'totp' });
    });

    it('手机丢了：用恢复码登录，每个只能用一次', async () => {
      const { challenge } = (await login('sales').expect(200)).body;
      const r = await loginTotp(challenge, recovery[0].toUpperCase().replace('-', ' ')).expect(200);
      token = r.body.accessToken;
      await loginTotp(challenge, recovery[0]).expect(401);
      const st = await as(token).get('/auth/totp').expect(200);
      expect(st.body.recoveryCodesLeft).toBe(7);
      expect(await prisma.auditLog.count({ where: { action: 'auth.recovery_used' } })).toBe(1);

      await as(token).post('/auth/totp/recovery-codes', { password: 'wrong' }).expect(400);
      const regen = await as(token)
        .post('/auth/totp/recovery-codes', { password: PASSWORD })
        .expect(200);
      expect(regen.body.recoveryCodes).toHaveLength(8);
      await loginTotp(challenge, recovery[1]).expect(401);
      recovery = regen.body.recoveryCodes;
    });

    it('验证码输错也算进锁定次数（只输对密码不会清零）', async () => {
      // 前面的用例里已经输错过几次，先清零
      await as(adminToken).post(`/users/${ids.sales}/unlock`).expect(200);
      const { challenge } = (await login('sales').expect(200)).body;
      for (let i = 0; i < 4; i++) await loginTotp(challenge, '111111').expect(401);
      const r = await loginTotp(challenge, '111111').expect(403);
      expect(r.body.code).toBe('ACCOUNT_LOCKED');
      await loginTotp(challenge, recovery[0]).expect(403);
      await as(adminToken).post(`/users/${ids.sales}/unlock`).expect(200);
    });

    it('关闭要输密码；管理员可以帮员工重置', async () => {
      await as(token).post('/auth/totp/disable', { password: 'wrong' }).expect(400);
      await as(token).post('/auth/totp/disable', { password: PASSWORD }).expect(200);
      expect((await login('sales').expect(200)).body.totpRequired).toBe(false);
      await as(adminToken).post(`/users/${ids.sales}/reset-totp`).expect(400);
    });
  });

  describe('角色要求两步验证', () => {
    it('打开后员工必须先设置，设置完才能用；开了不能关；管理员重置后要重新设置', async () => {
      const roles = await as(adminToken).get('/roles').expect(200);
      const finance = roles.body.find((r: { code: string }) => r.code === 'finance');
      expect(finance.requireTotp).toBe(false);
      await as(adminToken).patch(`/roles/${finance.id}`, { requireTotp: true }).expect(200);

      const token = (await login('finance').expect(200)).body.accessToken;
      const me = await as(token).get('/auth/me').expect(200);
      expect(me.body).toMatchObject({ mustSetupTotp: true, totpEnabled: false });
      const blocked = await as(token).get('/orders').expect(403);
      expect(blocked.body.code).toBe('TOTP_SETUP_REQUIRED');

      const { secret } = (await as(token).post('/auth/totp/setup').expect(200)).body;
      await as(token)
        .post('/auth/totp/enable', { code: totpCode(secret, totpStep()) })
        .expect(200);
      await as(token).get('/orders').expect(200);
      const st = await as(token).get('/auth/totp').expect(200);
      expect(st.body).toMatchObject({ enabled: true, required: true });
      const off = await as(token).post('/auth/totp/disable', { password: PASSWORD }).expect(400);
      expect(off.body.message).toContain('不能关闭');

      await as(adminToken).post(`/users/${ids.finance}/reset-totp`).expect(200);
      expect((await as(token).get('/orders').expect(403)).body.code).toBe('TOTP_SETUP_REQUIRED');
      const list = await as(adminToken).get('/users?keyword=finance').expect(200);
      expect(list.body.items[0].totpEnabled).toBe(false);
      await as(adminToken).patch(`/roles/${finance.id}`, { requireTotp: false }).expect(200);
      await as(token).get('/orders').expect(200);
    });
  });

  describe('登录设备', () => {
    it('新设备登录提醒本人；同一台设备再登录不提醒', async () => {
      await prisma.notification.deleteMany({ where: { event: 'security.new_device' } });
      const count = () =>
        prisma.notification.count({ where: { event: 'security.new_device', userId: ids.zhang } });
      await login('zhang', PASSWORD, { deviceId: 'device-aaa-1' }).expect(200);
      // 以前的登录都没带设备编号（升级前）：按浏览器 + 系统认，Chrome · Windows 以前用过
      expect(await count()).toBe(0);
      await login('zhang', PASSWORD, { deviceId: 'device-aaa-1' }).expect(200);
      expect(await count()).toBe(0);
      await login('zhang', PASSWORD, { deviceId: 'device-bbb-2' }, WECHAT_IPHONE).expect(200);
      expect(await count()).toBe(1);
      const n = await prisma.notification.findFirstOrThrow({
        where: { event: 'security.new_device', userId: ids.zhang },
      });
      expect(n.title).toBe('你的账号在新设备上登录：微信 · iPhone');
      expect(n.link).toBe('/account/security');
      // 换了一台同样是 Chrome · Windows 的电脑（设备编号不同）
      await login('zhang', PASSWORD, { deviceId: 'device-ccc-3' }).expect(200);
      expect(await count()).toBe(2);
    });

    it('看自己登录着的设备，退出某一台或其他全部；管理员可以强制下线', async () => {
      const a = (await login('zhang', PASSWORD, { deviceId: 'device-aaa-1' }).expect(200)).body
        .accessToken;
      const b = (
        await login('zhang', PASSWORD, { deviceId: 'device-bbb-2' }, WECHAT_IPHONE).expect(200)
      ).body.accessToken;
      const list = await as(a).get('/auth/sessions').expect(200);
      expect(list.body.length).toBeGreaterThanOrEqual(2);
      const current = list.body.filter((s: { current: boolean }) => s.current);
      expect(current).toHaveLength(1);
      expect(current[0].device).toBe('Chrome · Windows');
      const phone = list.body.find((s: { device: string }) => s.device === '微信 · iPhone');
      expect(phone.ip).toMatch(/^10\.9\./);

      await as(a).delete(`/auth/sessions/${current[0].id}`).expect(400);
      const bSession = (await as(b).get('/auth/sessions').expect(200)).body.find(
        (s: { current: boolean }) => s.current,
      );
      await as(a).delete(`/auth/sessions/${bSession.id}`).expect(200);
      await as(b).get('/auth/me').expect(401);

      const others = await as(a).post('/auth/sessions/revoke-others').expect(200);
      expect(others.body.count).toBeGreaterThan(0);
      expect((await as(a).get('/auth/sessions').expect(200)).body).toHaveLength(1);

      const history = await as(a).get('/auth/login-history').expect(200);
      expect(history.body[0]).toMatchObject({ action: 'auth.login', device: '微信 · iPhone' });
      expect(history.body[1]).toMatchObject({ action: 'auth.login', device: 'Chrome · Windows' });
      expect(history.body.some((h: { action: string }) => h.action === 'auth.locked')).toBe(true);

      const adminView = await as(adminToken).get(`/users/${ids.zhang}/sessions`).expect(200);
      expect(adminView.body).toHaveLength(1);
      const kick = await as(adminToken).post(`/users/${ids.zhang}/force-logout`).expect(200);
      expect(kick.body.count).toBe(1);
      await as(a).get('/auth/me').expect(401);
      await as(adminToken)
        .post(`/users/${await adminId()}/force-logout`)
        .expect(400);
    });

    it('别人的设备不能退出；没有员工管理权限不能看别人的设备', async () => {
      const t = (await login('sales').expect(200)).body.accessToken;
      const adminSessions = await prisma.session.findFirstOrThrow({
        where: { userId: await adminId(), revokedAt: null },
      });
      await as(t).delete(`/auth/sessions/${adminSessions.id}`).expect(404);
      await as(t).get(`/users/${ids.zhang}/sessions`).expect(403);
      await as(t).post(`/users/${ids.zhang}/unlock`).expect(403);
    });
  });

  async function adminId() {
    return (await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } })).id;
  }
});
