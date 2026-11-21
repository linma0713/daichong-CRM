import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { addDays, addMonths } from '../src/common/dates';
import { SweepService } from '../src/scheduler/sweep';
import { runSeed } from '../prisma/seed';

const PASSWORD = 'Crm2026test';

/**
 * M2 第一批：付款资源入库 → 开通 / 续费 / 内部续费扣成本 → 每单毛利；成品号库存 → 发号结转成本 → 回收回库
 */
describe('M2 库存与成本', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let sweep: SweepService;
  const http = () => request(app.getHttpServer());
  const tokens: Record<'admin' | 'sales' | 'fulfiller', string> = {
    admin: '',
    sales: '',
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

  /** 客服下单并收齐款，返回订单 ID 和派出的任务 ID */
  async function paidOrder(body: object, method = 'wechat') {
    const order = await as('sales').post('/orders', body).expect(201);
    const paid = await as('sales')
      .post(`/orders/${order.body.id}/payments`, { amountCents: order.body.amountCents, method })
      .expect(200);
    return {
      orderId: order.body.id as string,
      taskId: paid.body.tasks[0]?.id as string,
      body: paid.body,
    };
  }

  const resource = async (id = ids.card) =>
    (await prisma.paymentResource.findUniqueOrThrow({ where: { id } })) as {
      balanceUsdCents: number;
      costPoolCents: number;
    };
  /** 和后端一样按加权平均成本算一笔扣费的人民币成本 */
  const expectedCost = (r: { balanceUsdCents: number; costPoolCents: number }, usd: number) =>
    Math.round((r.costPoolCents * usd) / r.balanceUsdCents);

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "AuditLog", "Session", "UserRole", "User", "Role", "Team", "Customer",
        "FollowUp", "Plan", "Product", "Order", "Payment", "PaymentLink", "PaymentCallback", "ClaudeAccount", "Subscription",
        "FulfillmentTask", "Setting", "PaymentResource", "ResourceTransaction", "CostEntry",
        "Ticket", "TicketEvent", "Refund", "Agent"
        RESTART IDENTITY CASCADE`);
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
      ['sales', '客服小王', 'sales'],
      ['fulfiller', '充值员小张', 'fulfillment'],
    ] as const) {
      const s = await createStaff(key, name, role);
      tokens[key] = s.token;
      ids[key] = s.id;
    }

    const plans = await as('admin').get('/plans').expect(200);
    ids.pro = plans.body[0].id;
    ids.max = plans.body[1].id;
    for (const [key, planId, termMonths, fulfillmentType, priceCents] of [
      ['maxMonthly', ids.max, 1, 'RECHARGE', 100000],
      ['maxQuarterly', ids.max, 3, 'RECHARGE', 290000],
      ['proAccount', ids.pro, 1, 'ACCOUNT', 30000],
    ] as const) {
      const p = await as('admin')
        .post('/products', { planId, termMonths, fulfillmentType, priceCents })
        .expect(201);
      ids[key] = p.body.id;
    }
    const customer = await as('sales')
      .post('/customers', { name: '张先生', wechat: 'm2_zhang' })
      .expect(201);
    ids.customer = customer.body.id;
    const customer2 = await as('sales')
      .post('/customers', { name: '王总', wechat: 'm2_wang' })
      .expect(201);
    ids.customer2 = customer2.body.id;
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  describe('付款资源', () => {
    it('管理员新增虚拟卡并首次入库；平均成本 = 人民币 ÷ 美元', async () => {
      await as('fulfiller')
        .post('/resources', { type: 'VIRTUAL_CARD', name: '不该成功' })
        .expect(403);
      const res = await as('admin')
        .post('/resources', {
          type: 'VIRTUAL_CARD',
          name: 'Visa 虚拟卡 A',
          last4: '4242',
          feeBp: 150,
          lowBalanceUsdCents: 10000,
          secretNote: '4242 4242 4242 4242 / 12-28 / 123',
          initialUsdCents: 50000,
          initialCnyCents: 365000,
        })
        .expect(201);
      expect(res.body.code).toBe('R00001');
      expect(res.body.balanceUsdCents).toBe(50000);
      expect(res.body.avgRate).toBe(7.3);
      expect(res.body.hasSecretNote).toBe(true);
      expect(res.body).not.toHaveProperty('secretNote');
      ids.card = res.body.id;
    });

    it('充值员能看资源列表（完成任务时选），客服看不到', async () => {
      const list = await as('fulfiller').get('/resources').expect(200);
      expect(list.body).toHaveLength(1);
      await as('sales').get('/resources').expect(403);
    });

    it('查看卡号要权限并记日志', async () => {
      await as('sales').get(`/resources/${ids.card}/secret`).expect(403);
      const res = await as('fulfiller').get(`/resources/${ids.card}/secret`).expect(200);
      expect(res.body.secretNote).toContain('4242');
      const log = await prisma.auditLog.findFirst({ where: { action: 'resource.secret_view' } });
      expect(log?.userId).toBe(ids.fulfiller);
    });
  });

  describe('代充月付：收款手续费 + 开通扣费 = 每单毛利', () => {
    it('按收款方式的费率记手续费', async () => {
      await as('admin')
        .patch('/settings', {
          paymentFeeBp: { wechat: 60, alipay: 60, usdt: 0, bank: 0, other: 0 },
        })
        .expect(200);
      const { orderId, taskId, body } = await paidOrder({
        customerId: ids.customer,
        kind: 'NEW',
        productId: ids.maxMonthly,
        accountEmail: 'zhang@example.com',
        accountPassword: 'pass-zhang',
      });
      expect(body.payments[0].feeCents).toBe(600); // ¥1000 × 0.6%
      ids.order1 = orderId;
      ids.task1 = taskId;
    });

    it('已经配置了付款资源时，开通必须登记这次扣费', async () => {
      const res = await as('fulfiller').post(`/tasks/${ids.task1}/complete`, {}).expect(400);
      expect(res.body.code).toBe('CHARGE_REQUIRED');
      const task = await as('fulfiller').get(`/tasks/${ids.task1}`).expect(200);
      expect(task.body.chargeMode).toBe('required');
      expect(task.body.upstreamMonthlyUsdCents).toBe(10000);
    });

    it('选资源完成开通：扣 $100 + 1.5% 手续费，按平均成本记到订单上', async () => {
      const before = await resource();
      const cost = expectedCost(before, 10150);
      await as('fulfiller')
        .post(`/tasks/${ids.task1}/complete`, { resourceId: ids.card })
        .expect(200);
      const after = await resource();
      expect(after.balanceUsdCents).toBe(before.balanceUsdCents - 10150);
      expect(after.costPoolCents).toBe(before.costPoolCents - cost);

      const order = await as('admin').get(`/orders/${ids.order1}`).expect(200);
      expect(order.body.profit).toMatchObject({
        revenueCents: 100000,
        feeCents: 600,
        costCents: cost,
        marginCents: 100000 - 600 - cost,
        chargesDone: 1,
        chargesExpected: 1,
        estRemainingCostCents: 0,
      });
      expect(order.body.profit.costs[0]).toMatchObject({
        kind: 'UPSTREAM_CHARGE',
        usdCents: 10150,
        resourceName: 'Visa 虚拟卡 A',
      });
      expect(order.body.marginCents).toBe(100000 - 600 - cost);
      ids.sub1 = order.body.subscription.id;
    });

    it('客服看不到成本和毛利', async () => {
      const order = await as('sales').get(`/orders/${ids.order1}`).expect(200);
      expect(order.body.profit).toBeNull();
      expect(order.body.marginCents).toBeNull();
    });

    it('客户无缝续费：上游下次扣费的成本归到续费订单', async () => {
      const renewal = await paidOrder({
        customerId: ids.customer,
        kind: 'RENEWAL',
        productId: ids.maxMonthly,
        subscriptionId: ids.sub1,
      });
      expect(renewal.body.status).toBe('COMPLETED');
      ids.renewal1 = renewal.orderId;

      const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: ids.sub1 } });
      await sweep.run(addDays(sub.upstreamRenewAt!, -1));
      const task = await prisma.fulfillmentTask.findFirstOrThrow({
        where: { subscriptionId: ids.sub1, type: 'INTERNAL_RENEW' },
      });
      await as('fulfiller')
        .post(`/tasks/${task.id}/complete`, { resourceId: ids.card })
        .expect(200);
      const first = await as('admin').get(`/orders/${ids.order1}`).expect(200);
      const second = await as('admin').get(`/orders/${ids.renewal1}`).expect(200);
      expect(first.body.profit.chargesDone).toBe(1);
      expect(second.body.profit.chargesDone).toBe(1);
      expect(second.body.profit.costs[0].note).toContain('内部续费');
    });
  });

  describe('代充季付：开通扣 1 次，剩下 2 次按官方月费估算', () => {
    it('待收款的订单：预计毛利按收齐款算', async () => {
      const customer = await as('sales')
        .post('/customers', { name: '待收款客户', wechat: 'm2_unpaid' })
        .expect(201);
      const created = await as('sales')
        .post('/orders', {
          customerId: customer.body.id,
          kind: 'NEW',
          productId: ids.maxQuarterly,
          accountEmail: 'unpaid@example.com',
        })
        .expect(201);
      const order = await as('admin').get(`/orders/${created.body.id}`).expect(200);
      const p = order.body.profit;
      expect(p.revenueCents).toBe(0);
      expect(p.estUnpaidCents).toBe(created.body.amountCents);
      expect(p.estRemainingCostCents).toBe(3 * 10000 * 7.2);
      expect(p.estMarginCents).toBe(created.body.amountCents - 3 * 10000 * 7.2);
      await as('sales').post(`/orders/${created.body.id}/cancel`, { reason: '测试' }).expect(200);
      const cancelled = await as('admin').get(`/orders/${created.body.id}`).expect(200);
      expect(cancelled.body.profit.estUnpaidCents).toBe(0);
    });

    it('内部续费的成本归到季付订单，毛利里显示还要扣几次', async () => {
      const customer = await as('sales')
        .post('/customers', { name: '李女士', wechat: 'm2_li' })
        .expect(201);
      const { orderId, taskId } = await paidOrder({
        customerId: customer.body.id,
        kind: 'NEW',
        productId: ids.maxQuarterly,
        accountEmail: 'li@example.com',
      });
      await as('fulfiller').post(`/tasks/${taskId}/complete`, { resourceId: ids.card }).expect(200);
      let order = await as('admin').get(`/orders/${orderId}`).expect(200);
      expect(order.body.profit.chargesDone).toBe(1);
      expect(order.body.profit.chargesExpected).toBe(3);
      expect(order.body.profit.estRemainingCostCents).toBe((2 * 10000 * 7.2 * 100) / 100);

      const sub = await prisma.subscription.findUniqueOrThrow({
        where: { id: order.body.subscription.id },
      });
      await sweep.run(addDays(sub.upstreamRenewAt!, -1));
      const task = await prisma.fulfillmentTask.findFirstOrThrow({
        where: { subscriptionId: sub.id, type: 'INTERNAL_RENEW' },
      });
      // 这次实际扣了 $110（例如涨价），按填写的金额记
      const before = await resource();
      await as('fulfiller')
        .post(`/tasks/${task.id}/complete`, { resourceId: ids.card, chargeUsdCents: 11000 })
        .expect(200);
      order = await as('admin').get(`/orders/${orderId}`).expect(200);
      expect(order.body.profit.chargesDone).toBe(2);
      expect(order.body.profit.costs[1].usdCents).toBe(11165); // $110 + 1.5%
      expect(order.body.profit.costs[1].amountCents).toBe(expectedCost(before, 11165));
      expect(order.body.profit.estRemainingCostCents).toBe(72000);
    });
  });

  describe('余额不足、入库与盘点', () => {
    it('余额不够时拒绝完成任务，余额和任务都不变', async () => {
      const r = await resource();
      const customer = await as('sales')
        .post('/customers', { name: '赵先生', wechat: 'm2_zhao' })
        .expect(201);
      const { taskId } = await paidOrder({
        customerId: customer.body.id,
        kind: 'NEW',
        productId: ids.maxMonthly,
        accountEmail: 'zhao@example.com',
      });
      ids.zhaoTask = taskId;
      const res = await as('fulfiller')
        .post(`/tasks/${taskId}/complete`, {
          resourceId: ids.card,
          chargeUsdCents: r.balanceUsdCents,
        })
        .expect(400);
      expect(res.body.code).toBe('RESOURCE_INSUFFICIENT');
      expect((await resource()).balanceUsdCents).toBe(r.balanceUsdCents);
      const task = await as('fulfiller').get(`/tasks/${taskId}`).expect(200);
      expect(task.body.status).not.toBe('DONE');
    });

    it('入库后平均成本按加权重新计算；盘点改成实际余额', async () => {
      const before = await resource();
      const topped = await as('admin')
        .post(`/resources/${ids.card}/top-up`, { usdCents: 20000, cnyCents: 140000, note: '补卡' })
        .expect(200);
      expect(topped.body.balanceUsdCents).toBe(before.balanceUsdCents + 20000);
      expect(topped.body.costPoolCents).toBe(before.costPoolCents + 140000);

      await as('fulfiller')
        .post(`/resources/${ids.card}/adjust`, { actualUsdCents: 0, note: 'x' })
        .expect(403);
      const actual = topped.body.balanceUsdCents - 500;
      const adjusted = await as('admin')
        .post(`/resources/${ids.card}/adjust`, { actualUsdCents: actual, note: '对账少了 $5' })
        .expect(200);
      expect(adjusted.body.balanceUsdCents).toBe(actual);

      const txs = await as('admin').get(`/resources/${ids.card}/transactions`).expect(200);
      expect(txs.body.items.map((t: { type: string }) => t.type).slice(0, 2)).toEqual([
        'ADJUST',
        'TOP_UP',
      ]);
      const consume = txs.body.items.find((t: { type: string }) => t.type === 'CONSUME');
      expect(consume.order.code).toMatch(/^D\d{5}$/);

      await as('fulfiller')
        .post(`/tasks/${ids.zhaoTask}/complete`, { resourceId: ids.card })
        .expect(200);
    });

    it('余额低于预警线时出现在库存预警里', async () => {
      await as('admin')
        .patch(`/resources/${ids.card}`, { lowBalanceUsdCents: 1_000_000 })
        .expect(200);
      const sum = await as('admin').get('/inventory/summary').expect(200);
      expect(sum.body.lowResources.map((r: { id: string }) => r.id)).toEqual([ids.card]);
      const dash = await as('admin').get('/dashboard').expect(200);
      expect(dash.body.inventory.lowResources).toBe(1);
      const salesDash = await as('sales').get('/dashboard').expect(200);
      expect(salesDash.body.inventory).toBeNull();
      await as('admin').patch(`/resources/${ids.card}`, { lowBalanceUsdCents: 10000 }).expect(200);
    });
  });

  describe('成品号库存', () => {
    it('批量入库：每个号付第一个月 + 其他成本，重复的跳过', async () => {
      const before = await resource();
      const res = await as('admin')
        .post('/stock-accounts', {
          planId: ids.pro,
          resourceId: ids.card,
          costCnyCents: 1000,
          accounts: [
            { email: 'Stock1@example.com', password: 'p1' },
            { email: 'stock2@example.com', password: 'p2' },
            { email: 'stock1@example.com', password: 'p1' },
            { email: 'zhang@example.com', password: 'x' },
          ],
        })
        .expect(201);
      expect(res.body.created).toBe(2);
      expect(res.body.skipped.map((s: { reason: string }) => s.reason)).toEqual([
        '这次录入里重复了',
        '系统里已经有这个账号',
      ]);
      const stock = await as('fulfiller')
        .get(`/stock-accounts?planId=${ids.pro}&status=IN_STOCK`)
        .expect(200);
      expect(stock.body.items.map((a: { email: string }) => a.email)).toEqual([
        'stock1@example.com',
        'stock2@example.com',
      ]);
      // 第一个号：$20 + 1.5% 按入库前的平均成本，再加 ¥10
      const first = stock.body.items[0];
      expect(first.stockCostCents).toBe(expectedCost(before, 2030) + 1000);
      expect(new Date(first.upstreamRenewAt).getTime()).toBeGreaterThan(Date.now());
      ids.stock1 = first.id;
      ids.stock2 = stock.body.items[1].id;
      ids.stock1Cost = String(first.stockCostCents);

      const sum = await as('admin').get('/inventory/summary').expect(200);
      expect(sum.body.pools).toEqual([
        expect.objectContaining({ planName: 'Pro', inStock: 2, inUse: 0, low: false }),
      ]);
    });

    it('发号：从库存选号，备号成本结转到订单，上游扣费日沿用号上的', async () => {
      const { orderId, taskId } = await paidOrder({
        customerId: ids.customer2,
        kind: 'NEW',
        productId: ids.proAccount,
      });
      const task = await as('fulfiller').get(`/tasks/${taskId}`).expect(200);
      expect(task.body.chargeMode).toBe('optional');
      expect(task.body.planId).toBe(ids.pro);

      await as('fulfiller')
        .post(`/tasks/${taskId}/complete`, { stockAccountId: ids.stock1 })
        .expect(200);
      const order = await as('admin').get(`/orders/${orderId}`).expect(200);
      expect(order.body.profit.costCents).toBe(Number(ids.stock1Cost));
      expect(order.body.profit.costs[0].kind).toBe('ACCOUNT_STOCK');
      expect(order.body.profit.chargesDone).toBe(1);

      const account = await prisma.claudeAccount.findUniqueOrThrow({ where: { id: ids.stock1 } });
      expect(account).toMatchObject({
        stockStatus: 'IN_USE',
        stockCostCents: 0,
        customerId: ids.customer2,
      });
      const sub = await prisma.subscription.findFirstOrThrow({ where: { accountId: ids.stock1 } });
      expect(sub.upstreamRenewAt!.getTime()).toBeGreaterThan(Date.now() + 20 * 86400_000);
      ids.stockSub = sub.id;

      const sum = await as('admin').get('/inventory/summary').expect(200);
      expect(sum.body.pools[0]).toMatchObject({ inStock: 1, inUse: 1, low: true });
    });

    it('已发出的号不能再发给别人；套餐不对的号不能发', async () => {
      const other = await as('sales')
        .post('/customers', { name: '钱先生', wechat: 'm2_qian' })
        .expect(201);
      const { taskId } = await paidOrder({
        customerId: other.body.id,
        kind: 'NEW',
        productId: ids.proAccount,
      });
      const taken = await as('fulfiller')
        .post(`/tasks/${taskId}/complete`, { stockAccountId: ids.stock1 })
        .expect(400);
      expect(taken.body.message).toContain('正在给客户');

      await as('admin').patch(`/stock-accounts/${ids.stock2}`, { planId: ids.max }).expect(200);
      const wrongPlan = await as('fulfiller')
        .post(`/tasks/${taskId}/complete`, { stockAccountId: ids.stock2 })
        .expect(400);
      expect(wrongPlan.body.message).toContain('套餐');
      await as('admin').patch(`/stock-accounts/${ids.stock2}`, { planId: ids.pro }).expect(200);
      await as('fulfiller')
        .post(`/tasks/${taskId}/complete`, { stockAccountId: ids.stock2 })
        .expect(200);
    });

    it('使用中的号不能直接作废', async () => {
      const res = await as('admin')
        .patch(`/stock-accounts/${ids.stock1}`, { stockStatus: 'VOID' })
        .expect(400);
      expect(res.body.message).toContain('正在使用');
    });

    it('到期没续费：回收回库，成本清零，记下上游付费到哪天', async () => {
      const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: ids.stockSub } });
      const past = addDays(new Date(), -1);
      await prisma.subscription.update({ where: { id: sub.id }, data: { endAt: past } });
      await sweep.run(new Date());
      const reclaim = await prisma.fulfillmentTask.findFirstOrThrow({
        where: { subscriptionId: sub.id, type: 'RECLAIM_ACCOUNT' },
      });
      await as('fulfiller')
        .post(`/tasks/${reclaim.id}/complete`, { reclaimTo: 'STOCK', accountPassword: 'new-pass' })
        .expect(200);
      const account = await prisma.claudeAccount.findUniqueOrThrow({ where: { id: ids.stock1 } });
      expect(account).toMatchObject({
        stockStatus: 'IN_STOCK',
        stockCostCents: 0,
        customerId: null,
      });
      expect(account.upstreamRenewAt?.getTime()).toBe(sub.upstreamRenewAt?.getTime());
    });

    it('在库期间到了扣费日：登记扣费，成本累计到号上，付费日顺延一个月', async () => {
      const before = await resource();
      const account = await prisma.claudeAccount.findUniqueOrThrow({ where: { id: ids.stock1 } });
      const res = await as('admin')
        .post(`/stock-accounts/${ids.stock1}/charge`, { resourceId: ids.card })
        .expect(200);
      expect(res.body.stockCostCents).toBe(expectedCost(before, 2030));
      expect(new Date(res.body.upstreamRenewAt).getTime()).toBe(
        addMonths(account.upstreamRenewAt!, 1).getTime(),
      );
    });
  });
});
