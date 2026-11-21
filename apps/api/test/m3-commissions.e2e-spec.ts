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
type Who = 'admin' | 'sales' | 'fulfiller' | 'aftersales' | 'finance';

/**
 * M3 第二批：订单完成时计提佣金 → 冻结期 / 按月释放 → 退款扣减（作废、按比例扣、已发放记扣回）
 */
describe('M3 佣金计提、冻结与退款扣减', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let sweep: SweepService;
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

  /** 客服下单收齐款；complete 为真时由充值员完成开通 */
  async function paidOrder(body: object, complete = true) {
    const order = await as('sales').post('/orders', body).expect(201);
    const paid = await as('sales')
      .post(`/orders/${order.body.id}/payments`, {
        amountCents: order.body.amountCents,
        method: 'wechat',
      })
      .expect(200);
    const taskId = paid.body.tasks[0]?.id as string | undefined;
    if (complete && taskId) {
      await as('fulfiller').post(`/tasks/${taskId}/complete`, { resourceId: ids.card }).expect(200);
    }
    const o = await as('finance').get(`/orders/${order.body.id}`).expect(200);
    return o.body;
  }

  async function refund(orderId: string, amountCents: number, terminate = false) {
    const r = await as('aftersales')
      .post('/refunds', { orderId, amountCents, reason: '测试退款', terminate })
      .expect(201);
    const paid = await as('finance')
      .post(`/refunds/${r.body.id}/approve`, { method: 'wechat' })
      .expect(200);
    return paid.body;
  }

  const commissionsOf = (orderId: string) =>
    prisma.commission.findMany({
      where: { orderId },
      orderBy: [{ role: 'asc' }, { kind: 'asc' }, { seq: 'asc' }],
    });

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "AuditLog", "Session", "UserRole", "User", "Role", "Team", "Customer",
        "FollowUp", "Plan", "Product", "Order", "Payment", "ClaudeAccount", "Subscription",
        "FulfillmentTask", "Setting", "PaymentResource", "ResourceTransaction", "CostEntry",
        "Ticket", "TicketEvent", "Refund", "Agent", "Commission"
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
      ['aftersales', '售后小李', 'aftersales'],
      ['finance', '财务小陈', 'finance'],
    ] as const) {
      const s = await createStaff(key, name, role);
      tokens[key] = s.token;
      ids[key] = s.id;
    }

    const plans = await as('admin').get('/plans').expect(200);
    ids.pro = plans.body[0].id;
    ids.max = plans.body[1].id;
    for (const [key, planId, termMonths, priceCents, warrantyPriceCents] of [
      ['maxMonthly', ids.max, 1, 100000, null],
      ['proQuarter', ids.pro, 3, 90000, 15000],
    ] as const) {
      const p = await as('admin')
        .post('/products', {
          planId,
          termMonths,
          fulfillmentType: 'RECHARGE',
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
        initialUsdCents: 500000,
        initialCnyCents: 3600000,
      })
      .expect(201);
    ids.card = card.body.id;

    const li = await as('finance').post('/agents', { name: '老李' }).expect(201);
    ids.li = li.body.id;
    const zhou = await as('finance')
      .post('/agents', { name: '小周', parentId: ids.li })
      .expect(201);
    ids.zhou = zhou.body.id;
    const jie = await as('finance').post('/agents', { name: '阿杰' }).expect(201);
    ids.jie = jie.body.id;
    for (const [key, name, agentId] of [
      ['custA', '小周的客户', ids.zhou],
      ['custB', '阿杰的客户', ids.jie],
    ] as const) {
      const c = await as('sales')
        .post('/customers', { name, wechat: `m3c_${key}`, agentId })
        .expect(201);
      ids[key] = c.body.id;
    }
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  describe('计提与冻结', () => {
    it('收款后还没完成：不计提，毛利里按比例预估佣金', async () => {
      const o = await paidOrder(
        {
          customerId: ids.custA,
          kind: 'NEW',
          productId: ids.maxMonthly,
          accountEmail: 'a1@example.com',
        },
        false,
      );
      expect(o.status).toBe('FULFILLING');
      expect(o.commissions).toEqual([]);
      expect(o.profit).toMatchObject({ commissionCents: 0, estCommissionCents: 18000 });
      ids.order1 = o.id;
      ids.task1 = o.tasks[0].id;
    });

    it('开通完成时计提：直推 15% + 上级 3%，没加购质保的冻结 7 天，毛利扣掉佣金', async () => {
      await as('fulfiller')
        .post(`/tasks/${ids.task1}/complete`, { resourceId: ids.card })
        .expect(200);
      const o = (await as('finance').get(`/orders/${ids.order1}`).expect(200)).body;
      ids.sub1 = o.subscription.id;
      expect(o.status).toBe('COMPLETED');
      expect(o.commissions).toHaveLength(2);
      expect(o.commissions[0]).toMatchObject({
        role: 'DIRECT',
        kind: 'ACCRUAL',
        agent: { name: '小周' },
        rateBp: 1500,
        baseCents: 100000,
        amountCents: 15000,
        status: 'FROZEN',
        periods: 1,
      });
      expect(o.commissions[1]).toMatchObject({
        role: 'PARENT',
        agent: { name: '老李' },
        amountCents: 3000,
        status: 'FROZEN',
      });
      const completedAt = new Date(o.completedAt);
      expect(new Date(o.commissions[0].releaseAt)).toEqual(addDays(completedAt, 7));
      expect(o.profit.commissionCents).toBe(18000);
      expect(o.profit.estCommissionCents).toBe(0);
      expect(o.profit.marginCents).toBe(
        o.paidCents - o.refundedCents - o.profit.feeCents - o.profit.costCents - 18000,
      );
      expect(o.marginCents).toBe(o.profit.marginCents);
    });

    it('客服看订单看不到佣金明细', async () => {
      const o = await as('sales').get(`/orders/${ids.order1}`).expect(200);
      expect(o.body.commissions).toBeNull();
      await as('sales').get('/commissions').expect(403);
    });

    it('无缝续费（收款即完成）也计提，按续费比例 8%', async () => {
      const o = await paidOrder({
        customerId: ids.custA,
        kind: 'RENEWAL',
        subscriptionId: ids.sub1,
        productId: ids.maxMonthly,
      });
      expect(o.status).toBe('COMPLETED');
      expect(o.firstOrder).toBe(false);
      expect(o.commissions.map((c: { amountCents: number }) => c.amountCents)).toEqual([
        8000, 3000,
      ]);
      ids.renewal1 = o.id;
    });

    it('到期巡检：冻结满 7 天才变成可结算', async () => {
      const r1 = await sweep.run(addDays(new Date(), 6));
      expect(r1.releasedCommissions).toBe(0);
      const r2 = await sweep.run(addDays(new Date(), 8));
      expect(r2.releasedCommissions).toBe(4);
      const rows = await commissionsOf(ids.order1);
      expect(rows.every((r) => r.status === 'RELEASABLE' && r.releasedAt)).toBe(true);
    });
  });

  describe('退款扣减', () => {
    it('冻结期内全额退款：佣金作废，退款记下扣了多少佣金', async () => {
      const o = await paidOrder({
        customerId: ids.custA,
        kind: 'NEW',
        productId: ids.maxMonthly,
        accountEmail: 'a2@example.com',
      });
      expect(o.commissions.map((c: { amountCents: number }) => c.amountCents)).toEqual([
        8000, 3000,
      ]);
      const r = await refund(o.id, 100000, true);
      expect(r.commissionReducedCents).toBe(11000);
      const after = (await as('finance').get(`/orders/${o.id}`).expect(200)).body;
      expect(after.commissions.every((c: { status: string }) => c.status === 'VOID')).toBe(true);
      expect(after.commissions[0].refund.code).toBe(r.code);
      expect(after.profit.commissionCents).toBe(0);
    });

    it('可结算后部分退款：按退款占比直接扣', async () => {
      const r = await refund(ids.order1, 50000);
      expect(r.commissionReducedCents).toBe(9000);
      const rows = await commissionsOf(ids.order1);
      expect(rows.map((x) => [x.amountCents, x.status])).toEqual([
        [7500, 'RELEASABLE'],
        [1500, 'RELEASABLE'],
      ]);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: ids.order1 } });
      expect(order.commissionCents).toBe(9000);
    });

    it('已发放后再退款：记一条扣回（负数），下次对账抵扣', async () => {
      // 第三批做打款；这里直接把这单的佣金标成已发放
      await prisma.commission.updateMany({
        where: { orderId: ids.order1 },
        data: { status: 'PAID' },
      });
      const r = await refund(ids.order1, 50000);
      expect(r.commissionReducedCents).toBe(9000);
      const rows = await commissionsOf(ids.order1);
      const clawbacks = rows.filter((x) => x.kind === 'CLAWBACK');
      expect(clawbacks.map((x) => [x.role, x.amountCents, x.status])).toEqual([
        ['DIRECT', -7500, 'RELEASABLE'],
        ['PARENT', -1500, 'RELEASABLE'],
      ]);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: ids.order1 } });
      expect(order.commissionCents).toBe(0);
    });
  });

  describe('加购质保：按服务月逐月释放', () => {
    it('3 个月 + 质保：佣金拆 3 期，基数不含质保费，服务满一个月释放一期', async () => {
      const o = await paidOrder({
        customerId: ids.custB,
        kind: 'NEW',
        productId: ids.proQuarter,
        withWarranty: true,
        accountEmail: 'b1@example.com',
      });
      ids.orderB = o.id;
      expect(o.amountCents).toBe(105000);
      expect(o.commissionBaseCents).toBe(90000);
      expect(o.commissions).toHaveLength(3);
      expect(o.commissions.map((c: { amountCents: number }) => c.amountCents)).toEqual([
        4500, 4500, 4500,
      ]);
      expect(
        o.commissions.map((c: { seq: number; periods: number }) => `${c.seq}/${c.periods}`),
      ).toEqual(['1/3', '2/3', '3/3']);
      const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
      const start = row.periodStartAt!;
      expect(new Date(o.commissions[1].releaseAt)).toEqual(addMonths(start, 2));
      const r = await sweep.run(addDays(addMonths(start, 1), 1));
      expect(r.releasedCommissions).toBe(1);
    });

    it('质保期内退款终止服务：没释放的几期按比例作废，已释放的保留', async () => {
      // 退 2/3 的基数：佣金 13500 只留 4500
      const r = await refund(ids.orderB, 60000, true);
      expect(r.commissionReducedCents).toBe(9000);
      const rows = await commissionsOf(ids.orderB);
      expect(rows.map((x) => [x.seq, x.amountCents, x.status])).toEqual([
        [1, 4500, 'RELEASABLE'],
        [2, 0, 'VOID'],
        [3, 0, 'VOID'],
      ]);
    });
  });

  describe('佣金查询', () => {
    it('佣金明细按代理、状态筛选，带金额合计', async () => {
      const all = await as('finance').get(`/commissions?agentId=${ids.zhou}`).expect(200);
      // 小周：首单 15000→7500（已发放）+ 扣回 −7500；续费 8000；第二单作废
      expect(all.body.total).toBe(4);
      expect(all.body.sumCents).toBe(7500 - 7500 + 8000);
      const voided = await as('finance')
        .get(`/commissions?agentId=${ids.zhou}&status=VOID`)
        .expect(200);
      expect(voided.body.total).toBe(1);
      const byCode = await as('finance').get('/commissions?keyword=D00001').expect(200);
      expect(byCode.body.total).toBe(4);
    });

    it('按代理汇总：冻结中、可结算（含待扣回）、已发放', async () => {
      const res = await as('finance').get('/commissions/summary').expect(200);
      const zhou = res.body.find((s: { agent: { id: string } }) => s.agent.id === ids.zhou);
      expect(zhou).toMatchObject({
        frozenCents: 0,
        releasableCents: 8000 - 7500,
        clawbackCents: -7500,
        settledCents: 0,
        paidCents: 7500,
      });
      const jie = res.body.find((s: { agent: { id: string } }) => s.agent.id === ids.jie);
      expect(jie).toMatchObject({ frozenCents: 0, releasableCents: 4500, paidCents: 0 });
    });

    it('代理列表和详情带佣金汇总、每笔订单的佣金', async () => {
      const list = await as('finance').get('/agents').expect(200);
      const li = list.body.items.find((a: { id: string }) => a.id === ids.li);
      expect(li).toMatchObject({ paidCents: 1500, releasableCents: 3000 - 1500 });
      const detail = await as('finance').get(`/agents/${ids.li}`).expect(200);
      const o1 = detail.body.orders.find((o: { id: string }) => o.id === ids.order1);
      expect(o1).toMatchObject({ role: 'PARENT', commissionCents: 0 });
      const r1 = detail.body.orders.find((o: { id: string }) => o.id === ids.renewal1);
      expect(r1.commissionCents).toBe(3000);
    });
  });
});
