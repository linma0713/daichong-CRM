import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { configureApp } from '../src/bootstrap';
import { runSeed } from '../prisma/seed';
import { PrismaService } from '../src/prisma/prisma.service';
import { SettingsService } from '../src/settings/settings';
import { ReadinessService, type ReadinessItemDto } from '../src/readiness/readiness';
import { boxOf, rotateSecretKey } from '../src/cli/rotate-secret-key';
import { resetPassword } from '../src/cli/reset-password';

const PASSWORD = 'Crm2026test';
const APP_KEY = 'ab'.repeat(32);

/**
 * M4 第八批：上云准备。上线检查、更换加密密钥、多层反向代理下取真实 IP
 */
describe('M4 上云准备', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const http = () => request(app.getHttpServer());
  const tokens: Record<string, string> = {};
  let ipSeq = 0;
  const ip = () => `10.8.0.${++ipSeq}`;

  async function login(username: string, xff = ip()) {
    const res = await http()
      .post('/api/auth/login')
      .set('X-Forwarded-For', xff)
      .send({ username, password: PASSWORD })
      .expect(200);
    return res.body.accessToken as string;
  }

  /** 用指定配置单独造一个检查服务，测各种「没配好」的情况 */
  function readinessWith(env: Record<string, string | undefined>) {
    const config = new ConfigService({
      JWT_ACCESS_SECRET: 'a-real-secret-that-is-long-enough-0123456789',
      ACCOUNT_SECRET_KEY: APP_KEY,
      APP_PUBLIC_URL: 'https://crm.example.com',
      API_DOCS: 'off',
      ...env,
    });
    return new ReadinessService(app.get(PrismaService), config, app.get(SettingsService));
  }
  const item = async (env: Record<string, string | undefined>, key: string) =>
    (await readinessWith(env).check()).items.find((i) => i.key === key) as ReadinessItemDto;

  beforeAll(async () => {
    // 模拟上云：Caddy → nginx → 后端，两层代理
    process.env.TRUST_PROXY = '2';
    const { AppModule } = await import('../src/app.module');
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "AuditLog", "Session", "UserRole", "User", "Role", "Team", "Customer",
        "FollowUp", "Plan", "Product", "Order", "Payment", "PaymentLink", "PaymentCallback",
        "ClaudeAccount", "Subscription", "FulfillmentTask", "Setting", "PaymentResource",
        "ResourceTransaction", "CostEntry", "Ticket", "TicketEvent", "Refund", "Agent",
        "Commission", "CommissionStatement", "Notification", "NotifyChannel", "OutboundMessage",
        "ScriptTemplate", "Channel", "ChannelCost", "ReferralReward"
        RESTART IDENTITY CASCADE`);
    await runSeed(prisma, { adminUsername: 'admin', adminPassword: PASSWORD });
    await prisma.user.updateMany({ data: { mustChangePassword: false } });
    const finance = await prisma.role.findUniqueOrThrow({ where: { code: 'finance' } });
    const sales = await prisma.role.findUniqueOrThrow({ where: { code: 'sales' } });
    for (const [username, displayName, roleId] of [
      ['caiwu', '财务小陈', finance.id],
      ['kefu', '客服小王', sales.id],
    ] as const) {
      await prisma.user.create({
        data: {
          username,
          displayName,
          passwordHash: await bcrypt.hash(PASSWORD, 4),
          mustChangePassword: false,
          roles: { create: [{ roleId }] },
        },
      });
    }

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    tokens.admin = await login('admin');
    tokens.kefu = await login('kefu');
  });

  afterAll(async () => {
    delete process.env.TRUST_PROXY;
    await app.close();
    await prisma.$disconnect();
  });

  describe('真实 IP', () => {
    it('两层代理时，操作日志记的是最外面客户的 IP，不是代理的', async () => {
      await login('caiwu', '203.0.113.9, 172.18.0.5');
      const log = await prisma.auditLog.findFirst({
        where: { action: 'auth.login', user: { username: 'caiwu' } },
        orderBy: { createdAt: 'desc' },
      });
      expect(log?.ip).toBe('203.0.113.9');
    });
  });

  describe('上线检查', () => {
    it('只有能改业务设置的人能看', async () => {
      await http().get('/api/system/readiness').auth(tokens.kefu, { type: 'bearer' }).expect(403);
      const res = await http()
        .get('/api/system/readiness')
        .auth(tokens.admin, { type: 'bearer' })
        .expect(200);
      expect(res.body.items.map((i: ReadinessItemDto) => i.key)).toEqual([
        'jwt_secret',
        'account_key',
        'admin_password',
        'public_url',
        'totp',
        'online_pay',
        'backup',
        'api_docs',
      ]);
      // 测试环境：对外地址没配或是 localhost、没有自动备份、接口文档开着（密钥看本机 .env，不检查）
      const byKey = Object.fromEntries(
        res.body.items.map((i: ReadinessItemDto) => [i.key, i.status]),
      );
      expect(byKey).toMatchObject({
        public_url: 'warn',
        backup: 'warn',
        api_docs: 'info',
      });
    });

    it('示例密钥：必须处理', async () => {
      expect(
        await item(
          { JWT_ACCESS_SECRET: 'change-me-access-secret-at-least-32-characters' },
          'jwt_secret',
        ),
      ).toMatchObject({ status: 'danger' });
      const key = await item({ ACCOUNT_SECRET_KEY: '0'.repeat(64) }, 'account_key');
      expect(key.status).toBe('danger');
      expect(key.detail).toContain('rotate-secret-key');
      expect((await item({}, 'jwt_secret')).status).toBe('ok');
    });

    it('管理员还在用初始密码：列出是谁', async () => {
      const weak = await item({ SEED_ADMIN_PASSWORD: PASSWORD }, 'admin_password');
      expect(weak.status).toBe('danger');
      expect(weak.detail).toContain('（admin）');
      expect(
        (await item({ SEED_ADMIN_PASSWORD: 'Something-else-1' }, 'admin_password')).status,
      ).toBe('ok');
    });

    it('对外地址：没填、本机、http 都提醒，https 正式域名才算好', async () => {
      expect((await item({ APP_PUBLIC_URL: undefined }, 'public_url')).status).toBe('warn');
      expect(
        (await item({ APP_PUBLIC_URL: 'http://localhost:8080' }, 'public_url')).detail,
      ).toContain('本机或局域网');
      expect((await item({ APP_PUBLIC_URL: 'http://192.168.1.8:8080' }, 'public_url')).status).toBe(
        'warn',
      );
      expect(
        (await item({ APP_PUBLIC_URL: 'http://crm.example.com' }, 'public_url')).detail,
      ).toContain('没有用 https');
      expect((await item({}, 'public_url')).status).toBe('ok');
    });

    it('管理员和财务没开两步验证：点名提醒；开了就通过', async () => {
      const t = await item({}, 'totp');
      expect(t.status).toBe('warn');
      expect(t.detail).toContain('财务小陈');
      expect(t.detail).not.toContain('客服小王');
      await prisma.user.updateMany({
        where: { username: { in: ['admin', 'caiwu'] } },
        data: { totpEnabledAt: new Date() },
      });
      expect((await item({}, 'totp')).status).toBe('ok');
      await prisma.user.updateMany({ data: { totpEnabledAt: null } });
    });

    it('在线收款用模拟通道：必须处理', async () => {
      expect((await item({}, 'online_pay')).status).toBe('ok');
      await http()
        .patch('/api/settings')
        .auth(tokens.admin, { type: 'bearer' })
        .send({ onlinePayChannel: 'mock' })
        .expect(200);
      expect((await item({}, 'online_pay')).status).toBe('danger');
      await http()
        .patch('/api/settings')
        .auth(tokens.admin, { type: 'bearer' })
        .send({ onlinePayChannel: 'off' })
        .expect(200);
    });

    it('自动备份：没有文件、太旧、失败记录都报出来，一天内有备份才算好', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'crm-backup-'));
      const none = await item({ BACKUP_DIR: dir }, 'backup');
      expect(none.status).toBe('danger');
      expect(none.detail).toContain('还没有数据库备份');

      const file = join(dir, 'db-20261121-0300.dump');
      writeFileSync(file, Buffer.alloc(2048));
      const fresh = await item({ BACKUP_DIR: dir }, 'backup');
      expect(fresh.status).toBe('ok');
      expect(fresh.detail).toContain('db-20261121-0300.dump（2 KB，1 小时内）');

      const old = new Date(Date.now() - 30 * 3_600_000);
      utimesSync(file, old, old);
      writeFileSync(join(dir, 'last-error'), 'pg_dump: connection refused\n');
      const stale = await item({ BACKUP_DIR: dir }, 'backup');
      expect(stale.status).toBe('danger');
      expect(stale.detail).toContain('30 小时前');
      expect(stale.detail).toContain('pg_dump: connection refused');

      expect((await item({ BACKUP_DIR: join(dir, 'nope') }, 'backup')).detail).toContain(
        '读不到备份目录',
      );
    });

    it('接口文档：关掉才算好', async () => {
      expect((await item({ API_DOCS: 'on' }, 'api_docs')).status).toBe('info');
      expect((await item({}, 'api_docs')).status).toBe('ok');
    });
  });

  describe('更换加密密钥', () => {
    const NEW_KEY = 'cd'.repeat(32);
    const oldBox = boxOf(APP_KEY);
    const newBox = boxOf(NEW_KEY);
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      const account = await prisma.claudeAccount.create({
        data: {
          email: 'rotate@example.com',
          ownership: 'CUSTOMER',
          passwordEnc: oldBox.encrypt('Claude-Pa55'),
          secretNoteEnc: oldBox.encrypt('恢复码 1234'),
        },
      });
      ids.account = account.id;
      const resource = await prisma.paymentResource.create({
        data: {
          type: 'VIRTUAL_CARD',
          name: '测试卡',
          cardNumberEnc: oldBox.encrypt('4111111111111111'),
          secretNoteEnc: oldBox.encrypt('CVV 123'),
        },
      });
      ids.resource = resource.id;
      const channel = await prisma.notifyChannel.create({
        data: {
          name: '运营群',
          webhookEnc: oldBox.encrypt('https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc'),
          webhookHint: 'abc',
          events: [],
        },
      });
      ids.channel = channel.id;
      await prisma.user.update({
        where: { username: 'admin' },
        data: { totpSecret: oldBox.encrypt('JBSWY3DPEHPK3PXP') },
      });
    });

    it('先检查：列出每类要重新加密几条，不改数据', async () => {
      const r = await rotateSecretKey(prisma, oldBox, newBox, false);
      expect(r.applied).toBe(false);
      expect(r.lines.map((l) => [l.label, l.toRotate])).toEqual([
        ['Claude 账号密码', 1],
        ['Claude 账号其他敏感信息', 1],
        ['付款资源完整卡号', 1],
        ['付款资源其他敏感信息（CVV 等）', 1],
        ['企业微信群机器人地址', 1],
        ['员工两步验证密钥', 1],
      ]);
      const a = await prisma.claudeAccount.findUniqueOrThrow({ where: { id: ids.account } });
      expect(oldBox.decrypt(a.passwordEnc!)).toBe('Claude-Pa55');
    });

    it('有一条新旧密钥都解不开：整批不改', async () => {
      await prisma.claudeAccount.create({
        data: {
          email: 'broken@example.com',
          ownership: 'CUSTOMER',
          passwordEnc: boxOf('ef'.repeat(32)).encrypt('x'),
        },
      });
      const r = await rotateSecretKey(prisma, oldBox, newBox, true);
      expect(r.applied).toBe(false);
      expect(r.lines[0].failed).toHaveLength(1);
      const a = await prisma.claudeAccount.findUniqueOrThrow({ where: { id: ids.account } });
      expect(oldBox.decrypt(a.passwordEnc!)).toBe('Claude-Pa55');
      await prisma.claudeAccount.delete({ where: { email: 'broken@example.com' } });
    });

    it('执行：全部换成新密钥加密，内容不变；再执行一次什么都不用做', async () => {
      const r = await rotateSecretKey(prisma, oldBox, newBox, true);
      expect(r.applied).toBe(true);
      const a = await prisma.claudeAccount.findUniqueOrThrow({ where: { id: ids.account } });
      expect(newBox.decrypt(a.passwordEnc!)).toBe('Claude-Pa55');
      expect(newBox.decrypt(a.secretNoteEnc!)).toBe('恢复码 1234');
      expect(() => oldBox.decrypt(a.passwordEnc!)).toThrow();
      const res = await prisma.paymentResource.findUniqueOrThrow({ where: { id: ids.resource } });
      expect(newBox.decrypt(res.cardNumberEnc!)).toBe('4111111111111111');
      expect(newBox.decrypt(res.secretNoteEnc!)).toBe('CVV 123');
      const ch = await prisma.notifyChannel.findUniqueOrThrow({ where: { id: ids.channel } });
      expect(newBox.decrypt(ch.webhookEnc)).toContain('key=abc');
      const u = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' } });
      expect(newBox.decrypt(u.totpSecret!)).toBe('JBSWY3DPEHPK3PXP');

      const again = await rotateSecretKey(prisma, oldBox, newBox, true);
      expect(again.applied).toBe(false);
      expect(again.lines.every((l) => l.toRotate === 0 && l.failed.length === 0)).toBe(true);
      expect(again.lines.reduce((n, l) => n + l.alreadyNew, 0)).toBe(6);
    });
  });
  describe('服务器上重置密码', () => {
    it('生成临时密码、要求改密码、解锁、退出所有设备，可选清掉两步验证，记操作日志', async () => {
      await prisma.user.update({
        where: { username: 'caiwu' },
        data: {
          failedLogins: 5,
          lockedUntil: new Date(Date.now() + 600_000),
          totpSecret: 'x',
          totpEnabledAt: new Date(),
        },
      });
      const before = await prisma.session.count({
        where: { user: { username: 'caiwu' }, revokedAt: null },
      });
      expect(before).toBeGreaterThan(0);
      const r = await resetPassword(prisma, 'caiwu', false);
      expect(r.password).toMatch(/^Tmp-[A-Za-z2-9]{10}$/);
      expect(r.cleared2fa).toBe(false);
      const u = await prisma.user.findUniqueOrThrow({ where: { username: 'caiwu' } });
      expect(u).toMatchObject({ mustChangePassword: true, failedLogins: 0, lockedUntil: null });
      expect(u.totpEnabledAt).not.toBeNull();
      expect(await bcrypt.compare(r.password, u.passwordHash)).toBe(true);
      expect(await prisma.session.count({ where: { userId: u.id, revokedAt: null } })).toBe(0);

      const r2 = await resetPassword(prisma, 'caiwu', true);
      expect(r2.cleared2fa).toBe(true);
      const u2 = await prisma.user.findUniqueOrThrow({ where: { username: 'caiwu' } });
      expect(u2).toMatchObject({ totpSecret: null, totpEnabledAt: null, totpRecoveryHashes: [] });
      const logs = await prisma.auditLog.count({
        where: { action: 'user.reset_password_cli', resourceId: u.id },
      });
      expect(logs).toBe(2);
      await expect(resetPassword(prisma, 'nobody', false)).rejects.toThrow('没有这个员工账号');
    });
  });
});
