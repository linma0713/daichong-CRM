import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { shiftMonth } from '@crm/shared';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { addDays, addHours, localDateKey, parseLocalDate } from '../src/common/dates';
import { SweepService } from '../src/scheduler/sweep';
import { runSeed } from '../prisma/seed';

const PASSWORD = 'Crm2026test';
type Who = 'admin' | 'sales' | 'fulfiller' | 'aftersales' | 'finance';

/**
 * M3 第三批：月度对账单（生成 → 确认 → 打款 / 作废），代理代收抵扣，财务报表里的代理佣金
 */
describe('M3 佣金对账单与代理代收', () => {
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
  });
  const month = localDateKey(new Date()).slice(0, 7);
  const today = localDateKey(new Date());
  /** 某个月 1 号北京时间凌晨 1 点（巡检时间） */
  const firstOf = (m: string) => addHours(parseLocalDate(`${m}-01`)!, 1);

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

  /** 客服下单、按指定方式收齐款，充值员完成开通 */
  async function completedOrder(customerId: string, accountEmail: string, method = 'wechat') {
    const order = await as('sales')
      .post('/orders', { customerId, kind: 'NEW', productId: ids.maxMonthly, accountEmail })
      .expect(201);
    const paid = await as('sales')
      .post(`/orders/${order.body.id}/payments`, { amountCents: order.body.amountCents, method })
      .expect(200);
    await as('fulfiller')
      .post(`/tasks/${paid.body.tasks[0].id}/complete`, { resourceId: ids.card })
      .expect(200);
    return (await as('finance').get(`/orders/${order.body.id}`).expect(200)).body;
  }

  async function refund(orderId: string, amountCents: number) {
    const r = await as('aftersales')
      .post('/refunds', { orderId, amountCents, reason: '测试退款', terminate: false })
      .expect(201);
    return (
      await as('finance').post(`/refunds/${r.body.id}/approve`, { method: 'wechat' }).expect(200)
    ).body;
  }

  /** 把冻结中的佣金解冻时间挪到昨天，再跑一次巡检 */
  async function releaseAll() {
    await prisma.commission.updateMany({
      where: { status: 'FROZEN' },
      data: { releaseAt: addDays(new Date(), -1) },
    });
    await sweep.run();
  }

  const statementOf = async (agentId: string, status?: string) => {
    const list = await as('finance')
      .get(`/commission-statements?agentId=${agentId}${status ? `&status=${status}` : ''}`)
      .expect(200);
    return list.body.items[0];
  };

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "AuditLog", "Session", "UserRole", "User", "Role", "Team", "Customer",
        "FollowUp", "Plan", "Product", "Order", "Payment", "PaymentLink", "PaymentCallback", "ClaudeAccount", "Subscription",
        "FulfillmentTask", "Setting", "PaymentResource", "ResourceTransaction", "CostEntry",
        "Ticket", "TicketEvent", "Refund", "Agent", "Commission", "CommissionStatement"
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
    const p = await as('admin')
      .post('/products', {
        planId: plans.body[1].id,
        termMonths: 1,
        fulfillmentType: 'RECHARGE',
        priceCents: 100000,
      })
      .expect(201);
    ids.maxMonthly = p.body.id;
    const card = await as('admin')
      .post('/resources', {
        type: 'VIRTUAL_CARD',
        name: '测试卡',
        initialUsdCents: 500000,
        initialCnyCents: 3600000,
      })
      .expect(201);
    ids.card = card.body.id;

    const li = await as('finance')
      .post('/agents', { name: '老李', payoutMethod: 'alipay', payoutAccount: 'li@example.com' })
      .expect(201);
    ids.li = li.body.id;
    const zhou = await as('finance')
      .post('/agents', { name: '小周', parentId: ids.li })
      .expect(201);
    ids.zhou = zhou.body.id;
    for (const [key, name, agentId] of [
      ['custA', '小周的客户甲', ids.zhou],
      ['custB', '小周的客户乙', ids.zhou],
      ['direct', '直客', null],
    ] as const) {
      const c = await as('sales')
        .post('/customers', { name, wechat: `m3s_${key}`, agentId })
        .expect(201);
      ids[key] = c.body.id;
    }
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  describe('代理代收', () => {
    it('直客的订单不能记代理代收', async () => {
      const o = await as('sales')
        .post('/orders', {
          customerId: ids.direct,
          kind: 'NEW',
          productId: ids.maxMonthly,
          accountEmail: 'd1@example.com',
        })
        .expect(201);
      const res = await as('sales')
        .post(`/orders/${o.body.id}/payments`, { amountCents: 100000, method: 'agent' })
        .expect(400);
      expect(res.body.message).toContain('不是代理客户');
      ids.directOrder = o.body.id;
    });

    it('代理客户的订单可以记代理代收：没有手续费，记下是哪个代理收的', async () => {
      const a = await completedOrder(ids.custA, 'a1@example.com');
      const b = await completedOrder(ids.custB, 'b1@example.com', 'agent');
      ids.orderA = a.id;
      ids.orderB = b.id;
      expect(b.payments[0]).toMatchObject({ method: 'agent', feeCents: 0, statement: null });
      const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: b.id } });
      expect(payment.agentId).toBe(ids.zhou);
      expect(b.commissions.map((c: { amountCents: number }) => c.amountCents)).toEqual([
        15000, 3000,
      ]);
    });
  });

  describe('生成对账单', () => {
    it('客服不能看也不能生成对账单', async () => {
      await as('sales').get('/commission-statements').expect(403);
      await as('sales').post('/commission-statements/generate', { month }).expect(403);
    });

    it('还冻结着的佣金不进对账单；代收款先进来', async () => {
      const r = await as('finance').post('/commission-statements/generate', { month }).expect(200);
      expect(r.body).toMatchObject({ month, created: 1, refreshed: 0, skipped: 0 });
      expect(r.body.items[0]).toMatchObject({
        agent: { name: '小周' },
        status: 'DRAFT',
        commissionCents: 0,
        collectedCents: 100000,
        payableCents: -100000,
        commissionCount: 0,
        paymentCount: 1,
        createdBy: { displayName: '财务小陈' },
      });
      ids.zhouStatement = r.body.items[0].id;
    });

    it('解冻后再生成：草稿补进佣金，老李单独一张，不重复出单', async () => {
      await releaseAll();
      const r = await as('finance').post('/commission-statements/generate', { month }).expect(200);
      expect(r.body).toMatchObject({ created: 1, refreshed: 1, skipped: 0 });
      const zhou = await statementOf(ids.zhou);
      expect(zhou).toMatchObject({
        id: ids.zhouStatement,
        commissionCents: 30000,
        collectedCents: 100000,
        payableCents: -70000,
        commissionCount: 2,
      });
      const li = await statementOf(ids.li);
      expect(li).toMatchObject({ commissionCents: 6000, payableCents: 6000 });
      ids.liStatement = li.id;
      const again = await as('finance')
        .post('/commission-statements/generate', { month })
        .expect(200);
      expect(again.body).toMatchObject({ created: 0, refreshed: 2 });
      expect(await prisma.commissionStatement.count()).toBe(2);
    });

    it('不能给还没到的月份出单，月份格式要对', async () => {
      await as('finance')
        .post('/commission-statements/generate', { month: shiftMonth(month, 1) })
        .expect(400);
      await as('finance').post('/commission-statements/generate', { month: '2026-13' }).expect(400);
    });

    it('对账单详情：佣金明细、代收款、代理收款账号', async () => {
      const d = (await as('finance').get(`/commission-statements/${ids.liStatement}`).expect(200))
        .body;
      expect(d.payout).toEqual({ method: 'alipay', account: 'li@example.com' });
      expect(d.commissions).toHaveLength(2);
      expect(d.commissions.every((c: { role: string }) => c.role === 'PARENT')).toBe(true);
      const z = (await as('finance').get(`/commission-statements/${ids.zhouStatement}`).expect(200))
        .body;
      expect(z.payments).toHaveLength(1);
      expect(z.payments[0]).toMatchObject({
        amountCents: 100000,
        customer: { name: '小周的客户乙' },
      });
      const order = (await as('finance').get(`/orders/${ids.orderB}`).expect(200)).body;
      expect(order.payments[0].statement.code).toBe(z.code);
    });

    it('草稿期间退款：直接扣明细，金额实时变化', async () => {
      await refund(ids.orderA, 50000);
      expect(await statementOf(ids.zhou)).toMatchObject({
        commissionCents: 22500,
        payableCents: -77500,
      });
      expect(await statementOf(ids.li)).toMatchObject({ commissionCents: 4500 });
    });
  });

  describe('确认与打款', () => {
    it('确认后金额定下来，明细变成已对账；不能重复确认', async () => {
      const d = (
        await as('finance')
          .post(`/commission-statements/${ids.zhouStatement}/confirm`, { note: '已和小周核对' })
          .expect(200)
      ).body;
      expect(d).toMatchObject({
        status: 'CONFIRMED',
        commissionCents: 22500,
        collectedCents: 100000,
        payableCents: -77500,
        confirmedBy: { displayName: '财务小陈' },
        note: '已和小周核对',
      });
      expect(d.commissions.every((c: { status: string }) => c.status === 'SETTLED')).toBe(true);
      await as('finance').post(`/commission-statements/${ids.zhouStatement}/confirm`).expect(400);
    });

    it('已对账后退款：记扣回，不改已确认的对账单', async () => {
      await refund(ids.orderB, 50000);
      const rows = await prisma.commission.findMany({
        where: { orderId: ids.orderB, kind: 'CLAWBACK' },
      });
      expect(rows.map((r) => [r.agentId, r.amountCents, r.statementId])).toEqual([
        [ids.zhou, -7500, null],
      ]);
      expect(await statementOf(ids.zhou)).toMatchObject({ payableCents: -77500 });
      // 老李那条还在草稿里，直接扣
      expect(await statementOf(ids.li)).toMatchObject({ commissionCents: 3000 });
    });

    it('代理要补交时登记打款必须选收款方式；登记后明细变成已发放', async () => {
      const res = await as('finance')
        .post(`/commission-statements/${ids.zhouStatement}/pay`, {})
        .expect(400);
      expect(res.body.message).toContain('代理补交');
      const d = (
        await as('finance')
          .post(`/commission-statements/${ids.zhouStatement}/pay`, {
            method: 'alipay',
            reference: '小周补交差额',
          })
          .expect(200)
      ).body;
      expect(d).toMatchObject({
        status: 'PAID',
        payMethod: 'alipay',
        payReference: '小周补交差额',
        paidBy: { displayName: '财务小陈' },
      });
      expect(d.commissions.every((c: { status: string }) => c.status === 'PAID')).toBe(true);
      await as('finance')
        .post(`/commission-statements/${ids.zhouStatement}/cancel`, { reason: '试试' })
        .expect(400);
    });

    it('只有待打款的单能登记打款', async () => {
      await as('finance')
        .post(`/commission-statements/${ids.liStatement}/pay`, { method: 'alipay' })
        .expect(400);
    });
  });

  describe('作废与每月自动出单', () => {
    it('作废：明细退回可结算，重新生成时另出一张', async () => {
      const d = (
        await as('finance')
          .post(`/commission-statements/${ids.liStatement}/cancel`, { reason: '金额有误' })
          .expect(200)
      ).body;
      expect(d).toMatchObject({ status: 'CANCELLED', note: '金额有误', commissionCents: 3000 });
      expect(d.commissions).toEqual([]);
      const rows = await prisma.commission.findMany({ where: { agentId: ids.li } });
      expect(rows.every((r) => r.status === 'RELEASABLE' && r.statementId === null)).toBe(true);

      const r = await as('finance').post('/commission-statements/generate', { month }).expect(200);
      // 小周这个月已结清，扣回留到下个月
      expect(r.body).toMatchObject({ created: 1, refreshed: 0, skipped: 1 });
      expect(r.body.items[0]).toMatchObject({ agent: { name: '老李' }, commissionCents: 3000 });
      ids.liStatement2 = r.body.items[0].id;
    });

    it('下月 1 号巡检：刷新上月草稿，只跑一次', async () => {
      const next = shiftMonth(month, 1);
      const r = await sweep.run(firstOf(next));
      expect(r.statementsGenerated).toBe(1);
      const setting = await prisma.setting.findUniqueOrThrow({
        where: { key: 'commissionStatementAutoMonth' },
      });
      expect(setting.value).toBe(month);
      const again = await sweep.run(addHours(firstOf(next), 1));
      expect(again.statementsGenerated).toBe(0);
    });

    it('再下个月 1 号：上月的扣回自动出一张单，代理要补交', async () => {
      const next = shiftMonth(month, 1);
      const r = await sweep.run(firstOf(shiftMonth(month, 2)));
      expect(r.statementsGenerated).toBe(1);
      const s = await prisma.commissionStatement.findFirstOrThrow({
        where: { agentId: ids.zhou, month: next },
      });
      expect(s.createdById).toBeNull();
      const z = await statementOf(ids.zhou, 'DRAFT');
      expect(z).toMatchObject({ month: next, commissionCents: -7500, payableCents: -7500 });
    });

    it('按状态、月份、编号筛选', async () => {
      const drafts = await as('finance').get('/commission-statements?status=DRAFT').expect(200);
      expect(drafts.body.total).toBe(2);
      const byMonth = await as('finance').get(`/commission-statements?month=${month}`).expect(200);
      expect(byMonth.body.total).toBe(3);
      const byNo = await as('finance').get('/commission-statements?keyword=J1').expect(200);
      expect(byNo.body.items.map((s: { code: string }) => s.code)).toEqual(['J00001']);
    });
  });

  describe('财务和首页', () => {
    it('财务报表：结清当天计入代理佣金，毛利扣掉；按代理分组；代理代收单独一行', async () => {
      const r = (await as('finance').get(`/finance/report?from=${today}&to=${today}`).expect(200))
        .body;
      expect(r.totals.commissionCents).toBe(22500);
      expect(r.totals.profitCents).toBe(
        r.totals.netCents - r.totals.costCents - r.totals.commissionCents,
      );
      const agentMethod = r.methods.find((m: { method: string }) => m.method === 'agent');
      expect(agentMethod).toMatchObject({ label: '代理代收', receivedCents: 100000, feeCents: 0 });
      const zhou = r.byAgent.find((g: { key: string }) => g.key === ids.zhou);
      expect(zhou).toMatchObject({ orderCount: 2, paidCents: 200000, refundedCents: 100000 });
      // 订单上的佣金：A 单 7500 + 1500，B 单 15000 + 1500 − 7500
      expect(zhou.commissionCents).toBe(18000);
    });

    it('收支明细：对账单结清记一条代理佣金支出', async () => {
      const j = (await as('finance').get(`/finance/journal?from=${today}&to=${today}`).expect(200))
        .body;
      const c = j.items.filter((i: { kind: string }) => i.kind === 'commission');
      expect(c).toHaveLength(1);
      expect(c[0]).toMatchObject({ category: '代理佣金', amountCents: -22500, orderId: null });
      expect(c[0].reference).toContain('J00001 · 小周 · 代收抵扣 ¥1,000.00');
    });

    it('首页：财务看到待确认、待打款的对账单；客服看不到', async () => {
      const d = (await as('finance').get('/dashboard').expect(200)).body;
      expect(d.commissions).toMatchObject({ draftStatements: 2, unpaidStatements: 0 });
      const s = (await as('sales').get('/dashboard').expect(200)).body;
      expect(s.commissions).toBeNull();
    });

    it('审计日志记下确认、打款、作废', async () => {
      const logs = await prisma.auditLog.findMany({
        where: { action: { startsWith: 'statement.' } },
        select: { action: true },
      });
      const actions = logs.map((l) => l.action);
      for (const a of [
        'statement.generate',
        'statement.confirm',
        'statement.pay',
        'statement.cancel',
      ]) {
        expect(actions).toContain(a);
      }
    });
  });
});
