import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { addDays } from '../src/common/dates';
import { CustomerStatsService } from '../src/customers/stats';
import { SweepService } from '../src/scheduler/sweep';
import { runSeed } from '../prisma/seed';

const PASSWORD = 'Crm2026test';
type Who = 'admin' | 'sales' | 'sales2' | 'zhang' | 'aftersales' | 'finance';

/**
 * M4 第二批：客户分层（潜在 / 新客 / 活跃 / 沉睡 / 流失）、VIP、召回名单、流失原因、话术库
 */
describe('M4 客户分层与话术库', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let stats: CustomerStatsService;
  let sweep: SweepService;
  const http = () => request(app.getHttpServer());
  const tokens = {} as Record<Who, string>;
  const ids: Record<string, string> = {};
  const as = (who: Who) => ({
    get: (url: string) => http().get(`/api${url}`).auth(tokens[who], { type: 'bearer' }),
    post: (url: string, body: object = {}) =>
      http().post(`/api${url}`).auth(tokens[who], { type: 'bearer' }).send(body),
    patch: (url: string, body: object = {}) =>
      http().patch(`/api${url}`).auth(tokens[who], { type: 'bearer' }).send(body),
    delete: (url: string) => http().delete(`/api${url}`).auth(tokens[who], { type: 'bearer' }),
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

  let seq = 0;
  async function newCustomer(who: Who = 'sales') {
    seq++;
    const c = await as(who)
      .post('/customers', { name: `分层客户${seq}`, wechat: `m4s_${seq}` })
      .expect(201);
    return c.body.id as string;
  }
  /** 下单并收齐款，返回订单 */
  async function pay(customerId: string, who: Who = 'sales') {
    seq++;
    const order = await as(who)
      .post('/orders', {
        customerId,
        kind: 'NEW',
        productId: ids.product,
        accountEmail: `m4s_${seq}@example.com`,
      })
      .expect(201);
    await as(who)
      .post(`/orders/${order.body.id}/payments`, {
        amountCents: order.body.amountCents,
        method: 'wechat',
      })
      .expect(200);
    return order.body as { id: string; amountCents: number };
  }
  async function activate(orderId: string) {
    const task = await prisma.fulfillmentTask.findFirstOrThrow({ where: { orderId } });
    await as('zhang').post(`/tasks/${task.id}/complete`, { resourceId: ids.card }).expect(200);
    return prisma.subscription.findFirstOrThrow({ where: { orders: { some: { id: orderId } } } });
  }
  const customer = async (id: string, who: Who = 'admin') =>
    (await as(who).get(`/customers/${id}`).expect(200)).body;
  const segments = async (who: Who = 'admin') =>
    (await as(who).get('/customers/segments').expect(200)).body;
  const stageCount = (seg: { stages: { stage: string; count: number }[] }, stage: string) =>
    seg.stages.find((s) => s.stage === stage)?.count;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "AuditLog", "Session", "UserRole", "User", "Role", "Team", "Customer",
        "FollowUp", "Plan", "Product", "Order", "Payment", "ClaudeAccount", "Subscription",
        "FulfillmentTask", "Setting", "PaymentResource", "ResourceTransaction", "CostEntry",
        "Ticket", "TicketEvent", "Refund", "Agent", "Commission", "CommissionStatement",
        "Notification", "NotifyChannel", "OutboundMessage", "ScriptTemplate"
        RESTART IDENTITY CASCADE`);
    await runSeed(prisma, { adminUsername: 'admin', adminPassword: PASSWORD });
    await prisma.user.updateMany({ data: { mustChangePassword: false } });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    stats = app.get(CustomerStatsService);
    sweep = app.get(SweepService);

    const admin = await http()
      .post('/api/auth/login')
      .send({ username: 'admin', password: PASSWORD })
      .expect(200);
    tokens.admin = admin.body.accessToken;
    for (const [key, name, role] of [
      ['sales', '客服小王', 'sales'],
      ['sales2', '客服小赵', 'sales'],
      ['zhang', '充值员小张', 'fulfillment'],
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
        planId: plans.body[0].id,
        termMonths: 1,
        fulfillmentType: 'RECHARGE',
        priceCents: 100000,
      })
      .expect(201);
    ids.product = p.body.id;
    const card = await as('admin')
      .post('/resources', {
        type: 'VIRTUAL_CARD',
        name: '测试卡',
        initialUsdCents: 1000000,
        initialCnyCents: 7200000,
      })
      .expect(201);
    ids.card = card.body.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('客户分层', () => {
    it('建档是潜在；收齐款马上变新客并记下累计实付；开通后有服务结束时间', async () => {
      const id = await newCustomer();
      expect(await customer(id)).toMatchObject({
        stage: 'LEAD',
        netPaidCents: 0,
        vip: false,
        firstPaidAt: null,
      });
      const order = await pay(id);
      const paid = await customer(id);
      expect(paid).toMatchObject({ stage: 'NEW', netPaidCents: 100000, paidOrderCount: 1 });
      expect(paid.firstPaidAt).not.toBeNull();
      expect(paid.stageChangedAt).not.toBeNull();
      const sub = await activate(order.id);
      const active = await customer(id);
      expect(active.stage).toBe('NEW');
      expect(new Date(active.serviceEndAt).getTime()).toBe(sub.endAt.getTime());
      ids.c1 = id;
      ids.c1Order = order.id;
      ids.c1Sub = sub.id;
    });

    it('随时间变化：新客满 30 天变活跃；服务结束后召回期内是沉睡，超过是流失', async () => {
      const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: ids.c1Sub } });
      // 31 天后：第一次付款超过 30 天，订阅还在服务中
      expect(await stats.refresh(prisma, [ids.c1], addDays(new Date(), 31))).toBe(1);
      expect((await customer(ids.c1)).stage).toBe('ACTIVE');
      // 订阅到期（巡检标成已到期），服务结束 5 天
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'EXPIRED' } });
      await stats.refresh(prisma, [ids.c1], addDays(sub.endAt, 5));
      expect((await customer(ids.c1)).stage).toBe('DORMANT');
      // 结束 31 天，默认召回期 30 天
      await stats.refresh(prisma, [ids.c1], addDays(sub.endAt, 31));
      expect((await customer(ids.c1)).stage).toBe('CHURNED');
      // 召回期改成 60 天：立即重新划分
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { endAt: addDays(new Date(), -40), startAt: addDays(new Date(), -70) },
      });
      await stats.refresh(prisma);
      expect((await customer(ids.c1)).stage).toBe('CHURNED');
      await as('admin').patch('/settings', { recallWindowDays: 60 }).expect(200);
      expect((await customer(ids.c1)).stage).toBe('DORMANT');
      await as('admin').patch('/settings', { recallWindowDays: 30 }).expect(200);
      expect((await customer(ids.c1)).stage).toBe('CHURNED');
      await as('admin').patch('/settings', { recallWindowDays: 0 }).expect(400);
    });

    it('手动终止的订阅按终止时间算服务结束', async () => {
      const id = await newCustomer();
      const order = await pay(id);
      const sub = await activate(order.id);
      await as('admin')
        .patch(`/subscriptions/${sub.id}`, { status: 'CANCELLED', reason: '客户不用了' })
        .expect(200);
      const c = await customer(id);
      expect(c.stage).toBe('DORMANT');
      expect(new Date(c.serviceEndAt).getTime()).toBeLessThan(sub.endAt.getTime());
      expect(new Date(c.serviceEndAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it('到期巡检顺带刷新分层并返回变化数', async () => {
      const id = await newCustomer();
      const order = await pay(id);
      const sub = await activate(order.id);
      // 订阅还标着服务中，但已经过了到期时间：巡检先标已到期，再刷新分层
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { endAt: addDays(new Date(), -2), startAt: addDays(new Date(), -32) },
      });
      const r = await sweep.run();
      expect(r.expired).toBeGreaterThanOrEqual(1);
      expect(r.customerStageChanges).toBeGreaterThanOrEqual(1);
      expect((await customer(id)).stage).toBe('DORMANT');
      ids.dormant = id;
    });

    it('退款审批后累计实付扣掉退款；VIP 按设置的门槛算，筛选可用', async () => {
      const id = await newCustomer();
      const o1 = await pay(id);
      await pay(id);
      await pay(id);
      expect(await customer(id)).toMatchObject({ netPaidCents: 300000, vip: true });
      const vipList = await as('admin').get('/customers?vip=true').expect(200);
      expect(vipList.body.items.map((c: { id: string }) => c.id)).toEqual([id]);

      const r = await as('aftersales')
        .post('/refunds', { orderId: o1.id, amountCents: 50000, reason: '协商退一半' })
        .expect(201);
      await as('finance').post(`/refunds/${r.body.id}/approve`, { method: 'wechat' }).expect(200);
      expect(await customer(id)).toMatchObject({ netPaidCents: 250000, vip: false });

      await as('admin').patch('/settings', { vipThresholdCents: 200000 }).expect(200);
      expect((await customer(id)).vip).toBe(true);
      expect((await segments()).vip).toBe(1);
      // 门槛设成 0 也不会把没付过款的客户算成 VIP
      await as('admin').patch('/settings', { vipThresholdCents: 0 }).expect(200);
      const lead = await newCustomer();
      expect((await customer(lead)).vip).toBe(false);
      await as('admin').patch('/settings', { vipThresholdCents: 300000 }).expect(200);
      // 按累计实付排序
      const sorted = await as('admin').get('/customers?sort=netPaid&pageSize=3').expect(200);
      expect(sorted.body.items[0].id).toBe(id);
    });

    it('分层统计按数据范围：客服只统计自己的客户', async () => {
      const mine = await newCustomer('sales2');
      await pay(mine, 'sales2');
      const seg = await segments('sales2');
      expect(seg.total).toBe(1);
      expect(stageCount(seg, 'NEW')).toBe(1);
      expect(stageCount(seg, 'LEAD')).toBe(0);
      const all = await segments('admin');
      expect(all.total).toBeGreaterThan(1);
      expect(all.stages.map((s: { stage: string }) => s.stage)).toEqual([
        'LEAD',
        'NEW',
        'ACTIVE',
        'DORMANT',
        'CHURNED',
      ]);
      expect(all.recallWindowDays).toBe(30);
      await as('sales2').get(`/customers/${ids.dormant}`).expect(404);
    });
  });

  describe('召回与流失原因', () => {
    it('召回名单：沉睡且服务结束后没联系过；记一次召回跟进就移出', async () => {
      const before = await segments('sales');
      expect(before.dormantUncontacted).toBeGreaterThanOrEqual(1);
      const dash = await as('sales').get('/dashboard').expect(200);
      expect(dash.body.customers.recallPending).toBe(before.dormantUncontacted);
      const list = await as('sales')
        .get('/customers?stage=DORMANT&uncontacted=true&sort=serviceEnd')
        .expect(200);
      expect(list.body.items.map((c: { id: string }) => c.id)).toContain(ids.dormant);

      await as('sales')
        .post(`/customers/${ids.dormant}/follow-ups`, {
          content: '微信问了下，说下周再看',
          kind: 'recall',
        })
        .expect(201);
      const c = await customer(ids.dormant, 'sales');
      expect(c.lastContactAt).not.toBeNull();
      expect(c.followUps[0]).toMatchObject({ kind: 'recall' });
      const after = await as('sales').get('/customers?stage=DORMANT&uncontacted=true').expect(200);
      expect(after.body.items.map((x: { id: string }) => x.id)).not.toContain(ids.dormant);
      expect((await segments('sales')).dormantUncontacted).toBe(before.dormantUncontacted - 1);
      const dash2 = await as('sales').get('/dashboard').expect(200);
      expect(dash2.body.customers.recallPending).toBe(before.dormantUncontacted - 1);
      // 不能手动记成「流失原因」类型的跟进，要走单独的入口
      await as('sales')
        .post(`/customers/${ids.dormant}/follow-ups`, { content: 'x', kind: 'lost_reason' })
        .expect(400);
    });

    it('记录流失原因：写进客户和跟进记录，统计分布；再付款自动清掉', async () => {
      await as('sales')
        .post(`/customers/${ids.dormant}/lost-reason`, { reason: 'nope' })
        .expect(400);
      await as('aftersales')
        .post(`/customers/${ids.dormant}/lost-reason`, { reason: 'price' })
        .expect(403);
      const res = await as('sales')
        .post(`/customers/${ids.dormant}/lost-reason`, {
          reason: 'price',
          note: '觉得比官方贵太多',
        })
        .expect(201);
      expect(res.body).toMatchObject({ lostReason: 'price', lostNote: '觉得比官方贵太多' });
      expect(res.body.followUps[0]).toMatchObject({
        kind: 'lost_reason',
        content: '流失原因：嫌贵。觉得比官方贵太多',
      });
      const seg = await segments('admin');
      expect(seg.lostReasons).toEqual(
        expect.arrayContaining([expect.objectContaining({ reason: 'price', count: 1 })]),
      );
      const byReason = await as('admin').get('/customers?lostReason=price').expect(200);
      expect(byReason.body.total).toBe(1);
      const log = await prisma.auditLog.findFirst({ where: { action: 'customer.lost_reason' } });
      expect(log).not.toBeNull();

      // 客户回来又买了（第一次付款就在今天，所以是新客）
      await pay(ids.dormant);
      expect(await customer(ids.dormant)).toMatchObject({
        stage: 'NEW',
        lostReason: null,
        lostNote: null,
        lostReasonAt: null,
      });
    });
  });

  describe('话术库', () => {
    it('所有员工都能看；客服可以维护；售后、充值员不能改', async () => {
      const list = await as('zhang').get('/scripts').expect(200);
      expect(list.body).toEqual([]);
      await as('aftersales')
        .post('/scripts', { category: 'renewal', title: 'x', content: 'y' })
        .expect(403);
      await as('sales')
        .post('/scripts', { category: 'nope', title: 'x', content: 'y' })
        .expect(400);
      const created = await as('sales')
        .post('/scripts', {
          category: 'renewal',
          title: '到期前提醒',
          content: '{客户称呼}您好，您的 {套餐} 将在 {到期日} 到期',
          sortOrder: 5,
        })
        .expect(201);
      expect(created.body).toMatchObject({
        category: 'renewal',
        useCount: 0,
        createdBy: { id: ids.sales },
      });
      await as('sales')
        .post('/scripts', { category: 'recall', title: '回访', content: '好久不见' })
        .expect(201);
      ids.script = created.body.id;

      const renewal = await as('aftersales').get('/scripts?category=renewal').expect(200);
      expect(renewal.body.map((s: { title: string }) => s.title)).toEqual(['到期前提醒']);
      const kw = await as('aftersales').get('/scripts?keyword=好久').expect(200);
      expect(kw.body).toHaveLength(1);

      await as('sales').patch(`/scripts/${ids.script}`, { title: '到期前 3 天' }).expect(200);
      await as('zhang').patch(`/scripts/${ids.script}`, { title: 'x' }).expect(403);
      const logs = await prisma.auditLog.findMany({
        where: { action: { in: ['script.create', 'script.update'] } },
      });
      expect(logs).toHaveLength(3);
    });

    it('复制一次记一次使用（不记操作日志）；删除', async () => {
      await as('aftersales').post(`/scripts/${ids.script}/used`).expect(200);
      await as('sales').post(`/scripts/${ids.script}/used`).expect(200);
      const s = await prisma.scriptTemplate.findUniqueOrThrow({ where: { id: ids.script } });
      expect(s.useCount).toBe(2);
      expect(s.lastUsedAt).not.toBeNull();
      expect(await prisma.auditLog.count({ where: { path: { contains: '/used' } } })).toBe(0);
      await as('sales').delete(`/scripts/${ids.script}`).expect(200);
      await as('sales').delete(`/scripts/${ids.script}`).expect(404);
    });
  });
});
