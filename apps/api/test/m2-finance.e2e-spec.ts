import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { addDays, localDateKey } from '../src/common/dates';
import { runSeed } from '../prisma/seed';

const PASSWORD = 'Crm2026test';
type Who = 'admin' | 'sales' | 'fulfiller' | 'aftersales' | 'finance';

/**
 * M2 第三批：财务对账（现金口径、每日、按收款方式、按商品 / 客服 / 来源、收支明细）+ 数据看板
 */
describe('M2 财务对账与数据看板', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const http = () => request(app.getHttpServer());
  const tokens: Record<Who, string> = {
    admin: '',
    sales: '',
    fulfiller: '',
    aftersales: '',
    finance: '',
  };
  const ids: Record<string, string> = {};
  const as = (who: Who) => ({
    get: (url: string) => http().get(`/api${url}`).auth(tokens[who], { type: 'bearer' }),
    post: (url: string, body: object = {}) =>
      http().post(`/api${url}`).auth(tokens[who], { type: 'bearer' }).send(body),
    patch: (url: string, body: object = {}) =>
      http().patch(`/api${url}`).auth(tokens[who], { type: 'bearer' }).send(body),
  });
  const today = localDateKey(new Date());
  const range = `from=${today}&to=${today}`;

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

  async function paidOrder(body: object, method: string, complete?: object) {
    const order = await as('sales').post('/orders', body).expect(201);
    const paid = await as('sales')
      .post(`/orders/${order.body.id}/payments`, { amountCents: order.body.amountCents, method })
      .expect(200);
    const taskId = paid.body.tasks[0]?.id as string;
    let subscriptionId: string | null = null;
    if (complete) {
      await as('fulfiller').post(`/tasks/${taskId}/complete`, complete).expect(200);
      const o = await as('admin').get(`/orders/${order.body.id}`).expect(200);
      subscriptionId = o.body.subscription.id;
    }
    return { orderId: order.body.id as string, subscriptionId: subscriptionId! };
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "AuditLog", "Session", "UserRole", "User", "Role", "Team", "Customer",
        "FollowUp", "Plan", "Product", "Order", "Payment", "ClaudeAccount", "Subscription",
        "FulfillmentTask", "Setting", "PaymentResource", "ResourceTransaction", "CostEntry",
        "Ticket", "TicketEvent", "Refund", "Agent"
        RESTART IDENTITY CASCADE`);
    await runSeed(prisma, { adminUsername: 'admin', adminPassword: PASSWORD });
    await prisma.user.updateMany({ data: { mustChangePassword: false } });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();

    const admin = await http()
      .post('/api/auth/login')
      .send({ username: 'admin', password: PASSWORD })
      .expect(200);
    tokens.admin = admin.body.accessToken;
    for (const [key, name, role] of [
      ['sales', '客服小王', 'sales'],
      ['fulfiller', '充值员小张', 'fulfillment'],
      ['aftersales', '售后小李', 'aftersales'],
      ['finance', '财务小陈', 'finance'],
    ] as const) {
      const s = await createStaff(key, name, role);
      tokens[key] = s.token;
      ids[key] = s.id;
    }

    await as('admin')
      .patch('/settings', { paymentFeeBp: { wechat: 60, alipay: 0, usdt: 0, bank: 0, other: 0 } })
      .expect(200);
    const plans = await as('admin').get('/plans').expect(200);
    ids.pro = plans.body[0].id;
    ids.max = plans.body[1].id;
    for (const [key, planId, fulfillmentType, priceCents, warrantyPriceCents] of [
      ['maxMonthly', ids.max, 'RECHARGE', 100000, null],
      ['proAccount', ids.pro, 'ACCOUNT', 30000, 3000],
    ] as const) {
      const p = await as('admin')
        .post('/products', {
          planId,
          termMonths: 1,
          fulfillmentType,
          priceCents,
          warrantyPriceCents,
        })
        .expect(201);
      ids[key] = p.body.id;
    }
    const card = await as('admin')
      .post('/resources', {
        type: 'VIRTUAL_CARD',
        name: '测试卡',
        initialUsdCents: 100000,
        initialCnyCents: 720000,
      })
      .expect(201);
    ids.card = card.body.id;
    await as('admin')
      .post('/stock-accounts', {
        planId: ids.pro,
        costCnyCents: 1500,
        accounts: [{ email: 'pro-a@example.com', password: 'pa' }],
      })
      .expect(201);
    const stock = await as('admin').get(`/stock-accounts?planId=${ids.pro}&status=IN_STOCK`);
    ids.stockA = stock.body.items[0].id;

    for (const [key, name, source] of [
      ['zhang', '张先生', 'organic'],
      ['wang', '王总', 'referral'],
    ] as const) {
      const c = await as('sales')
        .post('/customers', { name, wechat: `fin_${key}`, source })
        .expect(201);
      ids[key] = c.body.id;
    }

    // 张先生：Pro 成品号 + 质保，微信付 ¥330，从库存发号
    const zhang = await paidOrder(
      { customerId: ids.zhang, kind: 'NEW', productId: ids.proAccount, withWarranty: true },
      'wechat',
      { stockAccountId: ids.stockA },
    );
    ids.zhangOrder = zhang.orderId;
    ids.zhangSub = zhang.subscriptionId;
    // 王总：Max 代充，支付宝付 ¥1000，用卡扣上游
    const wang = await paidOrder(
      {
        customerId: ids.wang,
        kind: 'NEW',
        productId: ids.maxMonthly,
        accountEmail: 'wang@example.com',
      },
      'alipay',
      { resourceId: ids.card },
    );
    ids.wangOrder = wang.orderId;
    ids.wangSub = wang.subscriptionId;
    // 张先生退 ¥10（不终止），财务从微信退
    const refund = await as('aftersales')
      .post('/refunds', { orderId: ids.zhangOrder, amountCents: 1000, reason: '少送了一天' })
      .expect(201);
    await as('finance')
      .post(`/refunds/${refund.body.id}/approve`, { method: 'wechat', reference: 'WX-R1' })
      .expect(200);
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  describe('财务对账', () => {
    it('只有财务权限能看', async () => {
      await as('sales').get(`/finance/report?${range}`).expect(403);
      await as('aftersales').get(`/finance/journal?${range}`).expect(403);
      await as('finance').get(`/finance/report?${range}`).expect(200);
    });

    it('日期要合法，结束不能早于开始，最多 366 天', async () => {
      await as('finance').get('/finance/report?from=2026-13-01&to=2026-12-01').expect(400);
      await as('finance').get('/finance/report?from=2026-02-30&to=2026-03-01').expect(400);
      await as('finance').get('/finance/report?from=2026-11-20&to=2026-11-19').expect(400);
      await as('finance').get('/finance/report?from=2025-01-01&to=2026-11-20').expect(400);
      await as('finance').get('/finance/report?from=2026-01-01').expect(400);
    });

    it('现金口径汇总：收款 − 退款 − 手续费 = 净收入，再减成本 = 毛利', async () => {
      const res = await as('finance').get(`/finance/report?${range}`).expect(200);
      const costs = await prisma.costEntry.aggregate({ _sum: { amountCents: true } });
      const cost = costs._sum.amountCents ?? 0;
      expect(cost).toBeGreaterThan(1500);
      expect(res.body.totals).toEqual({
        receivedCents: 133000,
        paymentCount: 2,
        feeCents: 198, // 微信 ¥330 × 0.6%
        refundedCents: 1000,
        refundCount: 1,
        netCents: 133000 - 1000 - 198,
        costCents: cost,
        profitCents: 133000 - 1000 - 198 - cost,
        resourceSpendCents: 720000,
      });
      expect(res.body.days).toHaveLength(1);
      expect(res.body.days[0]).toMatchObject({
        date: today,
        receivedCents: 133000,
        costCents: cost,
      });
    });

    it('按收款方式对账（微信先于支付宝）', async () => {
      const res = await as('finance').get(`/finance/report?${range}`).expect(200);
      expect(res.body.methods).toEqual([
        {
          method: 'wechat',
          label: '微信',
          receivedCents: 33000,
          paymentCount: 1,
          feeCents: 198,
          refundedCents: 1000,
          refundCount: 1,
          netCents: 33000 - 198 - 1000,
        },
        {
          method: 'alipay',
          label: '支付宝',
          receivedCents: 100000,
          paymentCount: 1,
          feeCents: 0,
          refundedCents: 0,
          refundCount: 0,
          netCents: 100000,
        },
      ]);
    });

    it('按商品 / 客服 / 来源分组，毛利 = 实收 − 退款 − 手续费 − 成本', async () => {
      const res = await as('finance').get(`/finance/report?${range}`).expect(200);
      expect(res.body.byProduct.map((g: { label: string }) => g.label)).toEqual([
        'Max 月付（代充）',
        'Pro 月付（成品号）',
      ]);
      const pro = res.body.byProduct[1];
      expect(pro).toMatchObject({
        orderCount: 1,
        paidCents: 33000,
        refundedCents: 1000,
        feeCents: 198,
        costCents: 1500,
        marginCents: 33000 - 1000 - 198 - 1500,
      });
      expect(res.body.byStaff).toHaveLength(1);
      expect(res.body.byStaff[0]).toMatchObject({ label: '客服小王', orderCount: 2 });
      expect(
        res.body.bySource.map((g: { key: string; paidCents: number }) => [g.key, g.paidCents]),
      ).toEqual([
        ['referral', 100000],
        ['organic', 33000],
      ]);
    });

    it('别的日期查不到今天的数据', async () => {
      const y = localDateKey(addDays(new Date(), -1));
      const res = await as('finance').get(`/finance/report?from=${y}&to=${y}`).expect(200);
      expect(res.body.totals.receivedCents).toBe(0);
      expect(res.body.byProduct).toEqual([]);
    });

    it('收支明细：收款为正，退款和成本为负，合计等于毛利', async () => {
      const res = await as('finance').get(`/finance/journal?${range}`).expect(200);
      expect(res.body.truncated).toBe(false);
      const kinds = res.body.items.map((i: { kind: string }) => i.kind);
      expect(kinds.filter((k: string) => k === 'payment')).toHaveLength(2);
      expect(kinds.filter((k: string) => k === 'refund')).toHaveLength(1);
      const refund = res.body.items.find((i: { kind: string }) => i.kind === 'refund');
      expect(refund).toMatchObject({
        amountCents: -1000,
        category: '微信',
        reference: 'K00001 · WX-R1',
        userName: '财务小陈',
      });
      expect(refund.customer.name).toBe('张先生');
      const report = await as('finance').get(`/finance/report?${range}`).expect(200);
      const sum = res.body.items.reduce(
        (n: number, i: { amountCents: number; feeCents: number }) => n + i.amountCents - i.feeCents,
        0,
      );
      expect(sum).toBe(report.body.totals.profitCents);
    });
  });

  describe('数据看板', () => {
    it('要有看板权限（财务角色默认没有，管理员有）', async () => {
      await as('finance').get('/analytics').expect(403);
      await as('sales').get('/analytics').expect(403);
      await as('admin').get('/analytics?days=15').expect(400);
    });

    it('趋势、开通时效、客户价值', async () => {
      const res = await as('admin').get('/analytics?days=7').expect(200);
      expect(res.body.days).toBe(7);
      expect(res.body.trend).toHaveLength(7);
      const last = res.body.trend[6];
      expect(last).toMatchObject({
        date: today,
        receivedCents: 133000,
        refundedCents: 1000,
        paidOrders: 2,
        newCustomers: 2,
        activations: 2,
      });
      expect(res.body.activation).toMatchObject({ done: 2, onTime: 2, onTimeRate: 1 });
      expect(res.body.activation.avgMinutes).toBeGreaterThanOrEqual(0);
      expect(res.body.ltv).toMatchObject({ payingCustomers: 2, repeatCustomers: 0, avgOrders: 1 });
      expect(res.body.ltv.top.map((t: { customer: { name: string } }) => t.customer.name)).toEqual([
        '王总',
        '张先生',
      ]);
      expect(res.body.ltv.top[1].netCents).toBe(32000);
      expect(res.body.staff.sales[0]).toMatchObject({
        name: '客服小王',
        paidOrders: 2,
        paidCents: 133000,
        newCustomers: 2,
      });
      expect(res.body.staff.fulfillment[0]).toMatchObject({
        name: '充值员小张',
        done: 2,
        activations: 2,
        onTimeRate: 1,
      });
    });

    it('售后率与退款率', async () => {
      await as('sales')
        .post('/tickets', {
          customerId: ids.zhang,
          subscriptionId: ids.zhangSub,
          type: 'BANNED',
          description: '封号',
        })
        .expect(201);
      const res = await as('admin').get('/analytics?days=7').expect(200);
      expect(res.body.aftersales).toMatchObject({
        tickets: 1,
        subscriptionsWithTickets: 1,
        activeSubscriptions: 2,
        ticketRate: 0.5,
        refundedCents: 1000,
        receivedCents: 133000,
      });
      expect(res.body.aftersales.refundRate).toBeCloseTo(1000 / 133000);
      expect(
        res.body.aftersales.byType.find((t: { type: string }) => t.type === 'BANNED').count,
      ).toBe(1);
    });

    it('续费率：服务期在区间内结束的订单，后面有没有续费单', async () => {
      await prisma.order.update({
        where: { id: ids.zhangOrder },
        data: { periodEndAt: addDays(new Date(), -1) },
      });
      let res = await as('admin').get('/analytics?days=7').expect(200);
      expect(res.body.renewal).toMatchObject({ due: 1, renewed: 0, rate: 0 });

      const renewal = await as('sales')
        .post('/orders', {
          customerId: ids.zhang,
          kind: 'RENEWAL',
          productId: ids.proAccount,
          subscriptionId: ids.zhangSub,
        })
        .expect(201);
      await as('sales')
        .post(`/orders/${renewal.body.id}/payments`, {
          amountCents: renewal.body.amountCents,
          method: 'wechat',
        })
        .expect(200);
      res = await as('admin').get('/analytics?days=7').expect(200);
      expect(res.body.renewal).toMatchObject({ due: 1, renewed: 1, rate: 1 });
      expect(res.body.renewal.byPlan[0]).toMatchObject({ label: 'Pro', due: 1, renewed: 1 });
      expect(res.body.ltv.repeatCustomers).toBe(1);
    });
  });
});
