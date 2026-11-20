import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { addDays, addHours, addMonths, localDateKey } from '../src/common/dates';
import { SweepService } from '../src/scheduler/sweep';
import { runSeed } from '../prisma/seed';

const PASSWORD = 'Crm2026test';

/**
 * M1 主链路：套餐商品 → 客户 → 下单收款 → 开通任务 → 订阅 → 到期巡检 / 内部续费 / 续费 / 回收
 */
describe('M1 主链路', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let sweep: SweepService;
  const http = () => request(app.getHttpServer());
  const tokens: Record<'admin' | 'sales1' | 'sales2' | 'fulfiller', string> = {
    admin: '',
    sales1: '',
    sales2: '',
    fulfiller: '',
  };
  const ids: Record<string, string> = {};
  const as = (who: keyof typeof tokens) => ({
    get: (url: string) => http().get(`/api${url}`).auth(tokens[who], { type: 'bearer' }),
    post: (url: string, body: object = {}) =>
      http().post(`/api${url}`).auth(tokens[who], { type: 'bearer' }).send(body),
    patch: (url: string, body: object = {}) =>
      http().patch(`/api${url}`).auth(tokens[who], { type: 'bearer' }).send(body),
  });

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
    const res = await http()
      .post('/api/auth/login')
      .send({ username, password: PASSWORD })
      .expect(200);
    return { id: user.id, token: res.body.accessToken as string };
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "AuditLog", "Session", "UserRole", "User", "Role", "Team", "Customer",
        "FollowUp", "Plan", "Product", "Order", "Payment", "ClaudeAccount", "Subscription",
        "FulfillmentTask", "Setting" RESTART IDENTITY CASCADE`);
    await runSeed(prisma, { adminUsername: 'admin', adminPassword: PASSWORD });
    await prisma.user.updateMany({ data: { mustChangePassword: false } });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    sweep = app.get(SweepService);

    const admin = await http()
      .post('/api/auth/login')
      .send({ username: 'admin', password: PASSWORD })
      .expect(200);
    tokens.admin = admin.body.accessToken;
    for (const [key, name, role] of [
      ['sales1', '客服小王', 'sales'],
      ['sales2', '客服小李', 'sales'],
      ['fulfiller', '充值员小张', 'fulfillment'],
    ] as const) {
      const s = await createStaff(key, name, role);
      tokens[key] = s.token;
      ids[key] = s.id;
    }
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  describe('套餐与商品', () => {
    it('默认带 Pro / Max / Ultra 三个套餐', async () => {
      const res = await as('sales1').get('/plans').expect(200);
      expect(res.body.map((p: { code: string }) => p.code)).toEqual(['PRO', 'MAX', 'ULTRA']);
      ids.pro = res.body[0].id;
      ids.max = res.body[1].id;
    });

    it('客服不能改商品；管理员上架商品，并按汇率估算毛利', async () => {
      await as('sales1')
        .post('/products', {
          planId: ids.max,
          termMonths: 1,
          fulfillmentType: 'RECHARGE',
          priceCents: 100000,
        })
        .expect(403);

      const monthly = await as('admin')
        .post('/products', {
          planId: ids.max,
          termMonths: 1,
          fulfillmentType: 'RECHARGE',
          priceCents: 100000,
        })
        .expect(201);
      expect(monthly.body.name).toBe('Max 月付（代充）');
      expect(monthly.body.estCostCents).toBe(72000); // $100 × 7.2
      expect(monthly.body.estMarginCents).toBe(28000);
      ids.maxMonthly = monthly.body.id;

      const quarterly = await as('admin')
        .post('/products', {
          planId: ids.max,
          termMonths: 3,
          fulfillmentType: 'RECHARGE',
          priceCents: 290000,
        })
        .expect(201);
      expect(quarterly.body.name).toBe('Max 季付（代充）');
      ids.maxQuarterly = quarterly.body.id;

      const account = await as('admin')
        .post('/products', {
          planId: ids.pro,
          termMonths: 1,
          fulfillmentType: 'ACCOUNT',
          priceCents: 30000,
        })
        .expect(201);
      expect(account.body.name).toBe('Pro 月付（成品号）');
      ids.proAccount = account.body.id;

      const dup = await as('admin')
        .post('/products', {
          planId: ids.max,
          termMonths: 1,
          fulfillmentType: 'RECHARGE',
          priceCents: 1,
        })
        .expect(400);
      expect(dup.body.message).toContain('已经存在');
    });

    it('修改汇率后估算成本跟着变', async () => {
      await as('sales1').patch('/settings', { exchangeRate: 7 }).expect(403);
      await as('admin')
        .patch('/settings', { exchangeRate: 7, reminderDays: [1, 7, 3, 7] })
        .expect(200);
      const settings = await as('sales1').get('/settings').expect(200);
      expect(settings.body.reminderDays).toEqual([7, 3, 1]);
      const products = await as('sales1').get('/products?activeOnly=true').expect(200);
      const monthly = products.body.find((p: { id: string }) => p.id === ids.maxMonthly);
      expect(monthly.estCostCents).toBe(70000);
    });
  });

  describe('客户', () => {
    it('客服录入客户；联系方式重复会提示已被谁跟进', async () => {
      const res = await as('sales1')
        .post('/customers', {
          name: '张先生',
          wechat: 'zhang_wx',
          source: 'referral',
          tags: ['老客'],
        })
        .expect(201);
      expect(res.body.code).toBe('C00001');
      expect(res.body.owner.id).toBe(ids.sales1);
      ids.customer = res.body.id;

      const dup = await as('sales2')
        .post('/customers', { name: '张总', wechat: 'ZHANG_WX' })
        .expect(400);
      expect(dup.body.code).toBe('CUSTOMER_DUPLICATE');
      expect(dup.body.message).toContain('客服小王');
    });

    it('客服只能看到自己负责的客户', async () => {
      await as('sales2').get(`/customers/${ids.customer}`).expect(404);
      const list = await as('sales2').get('/customers').expect(200);
      expect(list.body.total).toBe(0);
      const mine = await as('sales1').get('/customers?keyword=C1').expect(200);
      expect(mine.body.total).toBe(1);
    });
  });

  describe('代充季付：下单 → 收款 → 开通 → 内部续费 → 续费', () => {
    let start: Date;

    it('代充新购必须填客户账号，密码加密保存', async () => {
      await as('sales1')
        .post('/orders', { customerId: ids.customer, kind: 'NEW', productId: ids.maxQuarterly })
        .expect(400);
      const res = await as('sales1')
        .post('/orders', {
          customerId: ids.customer,
          kind: 'NEW',
          productId: ids.maxQuarterly,
          discountCents: 10000,
          accountEmail: 'Zhang@Example.com',
          accountPassword: 'claude-pass-123',
        })
        .expect(201);
      expect(res.body).toMatchObject({
        code: 'D00001',
        status: 'PENDING_PAYMENT',
        productName: 'Max 季付（代充）',
        listPriceCents: 290000,
        amountCents: 280000,
        accountEmail: 'zhang@example.com',
      });
      ids.order1 = res.body.id;
      const account = await prisma.claudeAccount.findUniqueOrThrow({
        where: { email: 'zhang@example.com' },
      });
      expect(account.passwordEnc).toMatch(/^v1:/);
      expect(account.passwordEnc).not.toContain('claude-pass-123');
      ids.account1 = account.id;
    });

    it('分次收款；收齐后自动派开通任务给充值员', async () => {
      await as('sales1')
        .post(`/orders/${ids.order1}/payments`, { amountCents: 100000, method: 'wechat' })
        .expect(200);
      const over = await as('sales1')
        .post(`/orders/${ids.order1}/payments`, { amountCents: 190000, method: 'wechat' })
        .expect(400);
      expect(over.body.message).toContain('收款超过应收');
      const res = await as('sales1')
        .post(`/orders/${ids.order1}/payments`, {
          amountCents: 180000,
          method: 'alipay',
          reference: 'TX001',
        })
        .expect(200);
      expect(res.body.status).toBe('FULFILLING');
      expect(res.body.paidCents).toBe(280000);
      expect(res.body.payments).toHaveLength(2);
      expect(res.body.tasks).toHaveLength(1);
      expect(res.body.tasks[0]).toMatchObject({ type: 'ACTIVATE', status: 'PENDING' });
      expect(res.body.tasks[0].assignee.id).toBe(ids.fulfiller);

      // 收过款的订单不能直接取消
      await as('sales1').post(`/orders/${ids.order1}/cancel`, { reason: '测试' }).expect(400);
    });

    it('客服看不到任务工作台；充值员能看到并查看密码（记日志）', async () => {
      await as('sales1').get('/tasks').expect(403);
      const res = await as('fulfiller').get('/tasks?assignee=me').expect(200);
      expect(res.body.total).toBe(1);
      const task = res.body.items[0];
      expect(task.account).toMatchObject({ email: 'zhang@example.com', hasPassword: true });
      expect(task.order.code).toBe('D00001');
      ids.task1 = task.id;

      await as('sales1').get(`/accounts/${ids.account1}/secret`).expect(403);
      const secret = await as('fulfiller').get(`/accounts/${ids.account1}/secret`).expect(200);
      expect(secret.body.password).toBe('claude-pass-123');
      const log = await prisma.auditLog.findFirst({
        where: { action: 'account.secret_view', resourceId: ids.account1 },
      });
      expect(log?.userId).toBe(ids.fulfiller);
    });

    it('标记失败后可以重新处理；完成开通后生成订阅', async () => {
      const failed = await as('fulfiller')
        .post(`/tasks/${ids.task1}/fail`, { note: '客户账号要验证码' })
        .expect(200);
      expect(failed.body).toMatchObject({ status: 'FAILED', attempts: 1 });
      const claimed = await as('fulfiller').post(`/tasks/${ids.task1}/claim`).expect(200);
      expect(claimed.body.status).toBe('IN_PROGRESS');
      // 开通任务不能作废
      await as('fulfiller').post(`/tasks/${ids.task1}/cancel`, { note: 'x' }).expect(400);

      // 模拟约 3 个月前开通（之后用巡检走完整个服务期）。避开 29–31 日，免得月底对齐让日期算不准
      for (let k = 2; ; k++) {
        start = addDays(addMonths(new Date(), -3), k);
        if (Number(localDateKey(start).slice(8)) <= 28) break;
      }
      const done = await as('fulfiller')
        .post(`/tasks/${ids.task1}/complete`, { activatedAt: start.toISOString(), note: '已充值' })
        .expect(200);
      expect(done.body.status).toBe('DONE');
      expect(done.body.subscription.code).toBe('S00001');
      ids.sub1 = done.body.subscription.id;

      const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: ids.sub1 } });
      expect(sub.status).toBe('ACTIVE');
      expect(sub.endAt).toEqual(addMonths(start, 3));
      expect(sub.upstreamRenewAt).toEqual(addMonths(start, 1));
      expect(sub.ownerId).toBe(ids.sales1);

      const order = await as('sales1').get(`/orders/${ids.order1}`).expect(200);
      expect(order.body.status).toBe('COMPLETED');
      expect(order.body.subscription.code).toBe('S00001');
    });

    it('季付期间：上游扣费前生成内部续费任务，不会重复生成', async () => {
      for (const month of [1, 2]) {
        const at = addDays(addMonths(start, month), -1);
        const r1 = await sweep.run(at);
        expect(r1.internalRenewTasks).toBe(1);
        const r2 = await sweep.run(at);
        expect(r2.internalRenewTasks).toBe(0);

        const list = await as('fulfiller').get('/tasks?type=INTERNAL_RENEW').expect(200);
        expect(list.body.total).toBe(1);
        await as('fulfiller').post(`/tasks/${list.body.items[0].id}/complete`).expect(200);
        const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: ids.sub1 } });
        expect(sub.upstreamRenewAt).toEqual(addMonths(start, month + 1));
      }
    });

    it('服务期最后一个月：没续费就生成取消自动续订任务', async () => {
      const r = await sweep.run(addDays(addMonths(start, 3), -1));
      expect(r).toMatchObject({ internalRenewTasks: 0, cancelAutoRenewTasks: 1 });
      const list = await as('fulfiller').get('/tasks?type=CANCEL_AUTO_RENEW').expect(200);
      expect(list.body.items[0].subscription.code).toBe('S00001');
    });

    it('快到期时提醒负责的客服；写了续费提醒就不再提醒', async () => {
      const due = await as('sales1').get('/subscriptions?needsReminder=true').expect(200);
      expect(due.body.total).toBe(1);
      expect(due.body.items[0]).toMatchObject({ code: 'S00001', needsReminder: true });
      expect(due.body.items[0].daysLeft).toBeGreaterThan(0);
      const dash = await as('sales1').get('/dashboard').expect(200);
      expect(dash.body.subscriptions.needsReminder).toBe(1);
      expect(dash.body.tasks).toBeNull();

      // 其他客服看不到；充值员能看到全部订阅
      expect((await as('sales2').get('/subscriptions').expect(200)).body.total).toBe(0);
      expect((await as('fulfiller').get('/subscriptions').expect(200)).body.total).toBe(1);

      await as('sales1')
        .post(`/customers/${ids.customer}/follow-ups`, {
          content: '已微信提醒，客户说下周续',
          subscriptionId: ids.sub1,
        })
        .expect(201);
      const after = await as('sales1').get('/subscriptions?needsReminder=true').expect(200);
      expect(after.body.total).toBe(0);
      const detail = await as('sales1').get(`/subscriptions/${ids.sub1}`).expect(200);
      expect(detail.body.reminders).toHaveLength(1);
      expect(detail.body.orders).toHaveLength(1);
    });

    it('同套餐续费且自动续订开着：收款后直接延长服务期，取消续订任务自动作废', async () => {
      const order = await as('sales1')
        .post('/orders', {
          customerId: ids.customer,
          kind: 'RENEWAL',
          subscriptionId: ids.sub1,
          productId: ids.maxMonthly,
        })
        .expect(201);
      expect(order.body.accountEmail).toBe('zhang@example.com');
      // 同一个订阅不能同时有两张续费单
      await as('sales1')
        .post('/orders', {
          customerId: ids.customer,
          kind: 'RENEWAL',
          subscriptionId: ids.sub1,
          productId: ids.maxMonthly,
        })
        .expect(400);

      const paid = await as('sales1')
        .post(`/orders/${order.body.id}/payments`, { amountCents: 100000, method: 'usdt' })
        .expect(200);
      expect(paid.body.status).toBe('COMPLETED');
      expect(paid.body.tasks).toHaveLength(0);

      const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: ids.sub1 } });
      expect(sub.endAt).toEqual(addMonths(addMonths(start, 3), 1));
      const cancelTask = await prisma.fulfillmentTask.findFirstOrThrow({
        where: { subscriptionId: ids.sub1, type: 'CANCEL_AUTO_RENEW' },
      });
      expect(cancelTask.status).toBe('CANCELLED');
    });
  });

  describe('成品号：开通 → 到期 → 回收', () => {
    it('成品号开通要录入交付的账号', async () => {
      const order = await as('sales1')
        .post('/orders', { customerId: ids.customer, kind: 'NEW', productId: ids.proAccount })
        .expect(201);
      expect(order.body.accountEmail).toBeNull();
      const paid = await as('sales1')
        .post(`/orders/${order.body.id}/payments`, { amountCents: 30000, method: 'wechat' })
        .expect(200);
      const taskId = paid.body.tasks[0].id;

      await as('fulfiller').post(`/tasks/${taskId}/complete`, {}).expect(400);
      // 客户自己的号不能当成品号交付
      await as('fulfiller')
        .post(`/tasks/${taskId}/complete`, {
          accountEmail: 'zhang@example.com',
          accountPassword: 'x',
        })
        .expect(400);

      const activatedAt = addHours(addMonths(new Date(), -1), -2);
      const done = await as('fulfiller')
        .post(`/tasks/${taskId}/complete`, {
          activatedAt: activatedAt.toISOString(),
          accountEmail: 'stock01@example.com',
          accountPassword: 'stock-pass',
          accountSecretNote: '恢复邮箱 r@example.com',
        })
        .expect(200);
      ids.sub2 = done.body.subscription.id;
      const account = await prisma.claudeAccount.findUniqueOrThrow({
        where: { email: 'stock01@example.com' },
      });
      expect(account).toMatchObject({ ownership: 'COMPANY', customerId: ids.customer });
      ids.stock = account.id;
    });

    it('到期未续费：标记已到期，生成回收和取消自动续订任务', async () => {
      const r = await sweep.run();
      expect(r.expired).toBe(1);
      expect(r.reclaimTasks).toBe(1);
      expect(r.cancelAutoRenewTasks).toBe(1);
      const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: ids.sub2 } });
      expect(sub.status).toBe('EXPIRED');

      // 到期 7 天内还会提醒客服挽回
      const due = await as('sales1').get('/subscriptions?needsReminder=true').expect(200);
      expect(due.body.items.map((s: { id: string }) => s.id)).toContain(ids.sub2);
    });

    it('回收后账号回到公司，订阅终止，不能再续费', async () => {
      const list = await as('fulfiller').get('/tasks?type=RECLAIM_ACCOUNT').expect(200);
      const task = list.body.items[0];
      expect(task.account.email).toBe('stock01@example.com');
      await as('fulfiller')
        .post(`/tasks/${task.id}/complete`, { accountPassword: 'new-stock-pass' })
        .expect(200);

      const account = await prisma.claudeAccount.findUniqueOrThrow({ where: { id: ids.stock } });
      expect(account.customerId).toBeNull();
      const secret = await as('fulfiller').get(`/accounts/${ids.stock}/secret`).expect(200);
      expect(secret.body).toMatchObject({
        password: 'new-stock-pass',
        secretNote: '恢复邮箱 r@example.com',
      });
      const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: ids.sub2 } });
      expect(sub.status).toBe('CANCELLED');

      const renew = await as('sales1')
        .post('/orders', {
          customerId: ids.customer,
          kind: 'RENEWAL',
          subscriptionId: ids.sub2,
          productId: ids.proAccount,
        })
        .expect(400);
      expect(renew.body.message).toContain('已终止');
    });
  });

  describe('其他规则', () => {
    it('未收款的订单可以取消；0 元订单直接进入开通', async () => {
      const order = await as('sales1')
        .post('/orders', {
          customerId: ids.customer,
          kind: 'NEW',
          productId: ids.maxMonthly,
          accountEmail: 'li@example.com',
        })
        .expect(201);
      const cancelled = await as('sales1')
        .post(`/orders/${order.body.id}/cancel`, { reason: '客户不买了' })
        .expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');

      const free = await as('sales1')
        .post('/orders', {
          customerId: ids.customer,
          kind: 'NEW',
          productId: ids.maxMonthly,
          discountCents: 100000,
          accountEmail: 'li@example.com',
          remark: '老客推荐赠送',
        })
        .expect(201);
      expect(free.body.status).toBe('FULFILLING');
      expect(free.body.tasks).toHaveLength(1);
    });

    it('有服务中订阅的账号不能重复新购', async () => {
      const res = await as('sales1')
        .post('/orders', {
          customerId: ids.customer,
          kind: 'NEW',
          productId: ids.maxMonthly,
          accountEmail: 'zhang@example.com',
        })
        .expect(400);
      expect(res.body.message).toContain('请下续费订单');
    });

    it('别人正在处理的任务不能直接接手，转交后可以', async () => {
      const list = await as('fulfiller').get('/tasks?type=ACTIVATE').expect(200);
      const task = list.body.items[0];
      await as('fulfiller').post(`/tasks/${task.id}/claim`).expect(200);
      const taken = await as('admin').post(`/tasks/${task.id}/claim`).expect(403);
      expect(taken.body.message).toContain('充值员小张');
      await as('admin').post(`/tasks/${task.id}/assign`, { assigneeId: ids.sales1 }).expect(400);
      const pooled = await as('admin')
        .post(`/tasks/${task.id}/assign`, { assigneeId: null })
        .expect(200);
      expect(pooled.body).toMatchObject({ status: 'PENDING', assignee: null });
      const pool = await as('fulfiller').get('/tasks?assignee=unassigned').expect(200);
      expect(pool.body.total).toBe(1);
    });

    it('首页按权限返回不同板块', async () => {
      const sales = await as('sales1').get('/dashboard').expect(200);
      expect(sales.body.orders.monthReceivedCents).toBe(280000 + 100000 + 30000);
      expect(sales.body.customers.total).toBe(1);
      const fulfiller = await as('fulfiller').get('/dashboard').expect(200);
      expect(fulfiller.body.orders).toBeNull();
      expect(fulfiller.body.tasks.unassigned).toBe(1);
      const other = await as('sales2').get('/dashboard').expect(200);
      expect(other.body.orders.monthReceivedCents).toBe(0);
    });

    it('换负责人时订阅一起转', async () => {
      await as('sales1')
        .post(`/customers/${ids.customer}/transfer`, { ownerId: ids.sales2 })
        .expect(403);
      await as('admin')
        .post(`/customers/${ids.customer}/transfer`, { ownerId: ids.sales2 })
        .expect(201);
      const subs = await as('sales2').get('/subscriptions').expect(200);
      expect(subs.body.total).toBe(2);
    });
  });
});
