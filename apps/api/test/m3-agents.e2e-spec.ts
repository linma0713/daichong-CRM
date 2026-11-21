import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { runSeed } from '../prisma/seed';

const PASSWORD = 'Crm2026test';
type Who = 'admin' | 'sales' | 'finance';

/**
 * M3 第一批：代理档案（两级）、客户绑定代理、代录单、佣金比例快照（代理 > 商品 > 默认）
 */
describe('M3 代理与佣金比例', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const http = () => request(app.getHttpServer());
  const tokens: Record<Who, string> = { admin: '', sales: '', finance: '' };
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

  let customerSeq = 0;
  async function newCustomer(name: string, extra: object = {}) {
    customerSeq += 1;
    const res = await as('sales')
      .post('/customers', { name, wechat: `m3_c${customerSeq}`, ...extra })
      .expect(201);
    return res.body;
  }

  /** 客服录一单代充月付（新邮箱），返回订单 */
  let emailSeq = 0;
  async function newOrder(customerId: string, extra: object = {}, who: Who = 'sales') {
    emailSeq += 1;
    const res = await as(who)
      .post('/orders', {
        customerId,
        kind: 'NEW',
        productId: ids.maxMonthly,
        accountEmail: `m3-${emailSeq}@example.com`,
        ...extra,
      })
      .expect(201);
    return res.body;
  }

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

    const admin = await http()
      .post('/api/auth/login')
      .send({ username: 'admin', password: PASSWORD })
      .expect(200);
    tokens.admin = admin.body.accessToken;
    for (const [key, name, role] of [
      ['sales', '客服小王', 'sales'],
      ['finance', '财务小陈', 'finance'],
    ] as const) {
      const s = await createStaff(key, name, role);
      tokens[key] = s.token;
      ids[key] = s.id;
    }

    const plans = await as('admin').get('/plans').expect(200);
    ids.pro = plans.body[0].id;
    ids.max = plans.body[1].id;
    for (const [key, planId, priceCents, warrantyPriceCents] of [
      ['maxMonthly', ids.max, 100000, null],
      ['proMonthly', ids.pro, 30000, 5000],
    ] as const) {
      const p = await as('admin')
        .post('/products', {
          planId,
          termMonths: 1,
          fulfillmentType: 'RECHARGE',
          priceCents,
          warrantyPriceCents,
        })
        .expect(201);
      ids[key] = p.body.id;
    }
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  describe('代理档案', () => {
    it('客服不能看代理列表、不能新增代理，但能拿到下拉选项', async () => {
      await as('sales').get('/agents').expect(403);
      await as('sales').post('/agents', { name: '老李' }).expect(403);
      const opts = await as('sales').get('/agents/options').expect(200);
      expect(opts.body).toEqual([]);
    });

    it('财务新增一级代理和二级代理，编号 A00001 起', async () => {
      const li = await as('finance')
        .post('/agents', { name: '老李', wechat: ' laoli ', payoutMethod: 'alipay' })
        .expect(201);
      expect(li.body).toMatchObject({
        code: 'A00001',
        name: '老李',
        wechat: 'laoli',
        status: 'ACTIVE',
        parent: null,
        firstRateBp: null,
      });
      ids.li = li.body.id;
      const zhou = await as('finance')
        .post('/agents', { name: '小周', parentId: ids.li })
        .expect(201);
      expect(zhou.body.parent).toMatchObject({ code: 'A00001', name: '老李' });
      ids.zhou = zhou.body.id;
      const top2 = await as('finance').post('/agents', { name: '阿杰' }).expect(201);
      ids.jie = top2.body.id;

      const detail = await as('finance').get(`/agents/${ids.li}`).expect(200);
      expect(detail.body.childCount).toBe(1);
      expect(detail.body.children.map((c: { name: string }) => c.name)).toEqual(['小周']);
    });

    it('最多两级：二级代理不能再带下级，有下级的代理不能再挂到别人下面，上级不能是自己', async () => {
      const r1 = await as('finance')
        .post('/agents', { name: '小吴', parentId: ids.zhou })
        .expect(400);
      expect(r1.body.message).toContain('最多两级');
      const r2 = await as('finance').patch(`/agents/${ids.li}`, { parentId: ids.jie }).expect(400);
      expect(r2.body.message).toContain('已经有下级');
      await as('finance').patch(`/agents/${ids.jie}`, { parentId: ids.jie }).expect(400);
    });

    it('搜索和筛选：编号、名称、只看某个代理的下级', async () => {
      const byCode = await as('finance').get('/agents?keyword=A00002').expect(200);
      expect(byCode.body.items.map((a: { name: string }) => a.name)).toEqual(['小周']);
      const children = await as('finance').get(`/agents?parentId=${ids.li}`).expect(200);
      expect(children.body.total).toBe(1);
      const opts = await as('sales').get('/agents/options').expect(200);
      expect(opts.body.find((o: { id: string }) => o.id === ids.zhou).parentName).toBe('老李');
    });
  });

  describe('佣金比例设置', () => {
    it('默认 首单 15% / 续费 8% / 上级 3%，管理员可以改，客服不能', async () => {
      const s = await as('sales').get('/settings').expect(200);
      expect(s.body.commissionRatesBp).toEqual({ first: 1500, renewal: 800, parent: 300 });
      expect(s.body.commissionFreezeDays).toBe(7);
      expect(s.body.commissionIncludeWarranty).toBe(false);
      await as('sales')
        .patch('/settings', { commissionRatesBp: { first: 1000, renewal: 500, parent: 200 } })
        .expect(403);
      await as('admin')
        .patch('/settings', { commissionRatesBp: { first: 1500, renewal: 800, parent: 300 } })
        .expect(200);
      await as('admin')
        .patch('/settings', { commissionRatesBp: { first: 6000, renewal: 800, parent: 300 } })
        .expect(400);
    });

    it('商品可以单独设置佣金比例，null 表示按默认', async () => {
      const p = await as('admin')
        .patch(`/products/${ids.maxMonthly}`, { firstRateBp: 2000 })
        .expect(200);
      expect(p.body).toMatchObject({ firstRateBp: 2000, renewalRateBp: null, parentRateBp: null });
    });
  });

  describe('客户绑定代理', () => {
    it('新增客户时选代理：来源自动记为代理，记下绑定时间', async () => {
      const c = await newCustomer('周的客户甲', { agentId: ids.zhou });
      expect(c.source).toBe('agent');
      expect(c.agent).toMatchObject({ code: 'A00002', name: '小周' });
      expect(c.agentBoundAt).toBeTruthy();
      ids.custA = c.id;
    });

    it('客服第一次绑定可以；已绑定后改绑或解绑要「编辑代理」权限', async () => {
      const c = await newCustomer('后绑定的客户');
      ids.custLater = c.id;
      const bound = await as('sales').patch(`/customers/${c.id}`, { agentId: ids.jie }).expect(200);
      expect(bound.body.agent.name).toBe('阿杰');
      const r = await as('sales').patch(`/customers/${c.id}`, { agentId: ids.li }).expect(403);
      expect(r.body.message).toContain('编辑代理');
      await as('sales').patch(`/customers/${c.id}`, { agentId: null }).expect(403);
      // 同一个代理再提交一次不算改绑
      await as('sales').patch(`/customers/${c.id}`, { agentId: ids.jie }).expect(200);
      const moved = await as('admin').patch(`/customers/${c.id}`, { agentId: ids.li }).expect(200);
      expect(moved.body.agent.name).toBe('老李');
    });

    it('客户列表可以按代理筛选', async () => {
      const res = await as('admin').get(`/customers?agentId=${ids.zhou}`).expect(200);
      expect(res.body.items.map((c: { name: string }) => c.name)).toEqual(['周的客户甲']);
    });
  });

  describe('下单时快照佣金比例', () => {
    it('首单：直推按商品比例 20%，上级按默认 3%；客服看不到比例', async () => {
      const o = await newOrder(ids.custA);
      expect(o.agent).toMatchObject({ name: '小周' });
      expect(o.parentAgent).toMatchObject({ name: '老李' });
      expect(o.firstOrder).toBe(true);
      expect(o.agentRateBp).toBeNull();
      expect(o.commissionBaseCents).toBeNull();
      const f = await as('finance').get(`/orders/${o.id}`).expect(200);
      expect(f.body).toMatchObject({
        agentRateBp: 2000,
        parentRateBp: 300,
        commissionBaseCents: 100000,
      });
      ids.orderA1 = o.id;
    });

    it('之后的订单按续费比例；代理单独设置的比例优先于商品和默认', async () => {
      await as('finance').patch(`/agents/${ids.zhou}`, { renewalRateBp: 1000 }).expect(200);
      await as('finance').patch(`/agents/${ids.li}`, { parentRateBp: 500 }).expect(200);
      const o = await newOrder(ids.custA);
      const f = await as('finance').get(`/orders/${o.id}`).expect(200);
      expect(f.body).toMatchObject({ firstOrder: false, agentRateBp: 1000, parentRateBp: 500 });
      // 改比例不影响已下的单
      const old = await as('finance').get(`/orders/${ids.orderA1}`).expect(200);
      expect(old.body).toMatchObject({ agentRateBp: 2000, parentRateBp: 300 });
    });

    it('取消的订单不算首单', async () => {
      const c = await newCustomer('取消过的客户', { agentId: ids.jie });
      const o1 = await newOrder(c.id);
      await as('sales').post(`/orders/${o1.id}/cancel`, { reason: '录错了' }).expect(200);
      const o2 = await newOrder(c.id);
      const f = await as('finance').get(`/orders/${o2.id}`).expect(200);
      expect(f.body).toMatchObject({ firstOrder: true, agentRateBp: 2000, parentRateBp: 0 });
      expect(f.body.parentAgent).toBeNull();
    });

    it('客户没绑定代理时，下单可以指定代理并同时绑定；已绑定的客户不能算给别的代理', async () => {
      const c = await newCustomer('代录的客户');
      const o = await newOrder(c.id, { agentId: ids.jie });
      expect(o.agent.name).toBe('阿杰');
      const after = await as('sales').get(`/customers/${c.id}`).expect(200);
      expect(after.body.agent.name).toBe('阿杰');
      const r = await as('sales')
        .post('/orders', {
          customerId: ids.custA,
          kind: 'NEW',
          productId: ids.maxMonthly,
          accountEmail: 'm3-wrong@example.com',
          agentId: ids.jie,
        })
        .expect(400);
      expect(r.body.message).toContain('已绑定其他代理');
    });

    it('没有代理的客户：订单上代理为空、比例为 0', async () => {
      const c = await newCustomer('自然流量客户');
      const o = await newOrder(c.id, {}, 'admin');
      expect(o).toMatchObject({ agent: null, firstOrder: true, agentRateBp: null });
      const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
      expect(row).toMatchObject({ agentRateBp: 0, parentRateBp: 0, commissionBaseCents: 0 });
    });

    it('佣金基数默认不含质保费，设置成包含后按应收算', async () => {
      const c = await newCustomer('加质保的客户', { agentId: ids.jie });
      const o1 = await newOrder(c.id, { productId: ids.proMonthly, withWarranty: true });
      const f1 = await as('finance').get(`/orders/${o1.id}`).expect(200);
      expect(f1.body).toMatchObject({ amountCents: 35000, commissionBaseCents: 30000 });
      await as('admin').patch('/settings', { commissionIncludeWarranty: true }).expect(200);
      const o2 = await newOrder(c.id, { productId: ids.proMonthly, withWarranty: true });
      const f2 = await as('finance').get(`/orders/${o2.id}`).expect(200);
      expect(f2.body).toMatchObject({ commissionBaseCents: 35000, agentRateBp: 800 });
      await as('admin').patch('/settings', { commissionIncludeWarranty: false }).expect(200);
    });

    it('停用的代理：不能绑新客户；已绑定客户的新订单不再有佣金，停用的上级也不拿管理佣金', async () => {
      await as('finance').patch(`/agents/${ids.li}`, { status: 'DISABLED' }).expect(200);
      const r = await as('sales')
        .post('/customers', { name: '新客户', wechat: 'm3_disabled', agentId: ids.li })
        .expect(400);
      expect(r.body.message).toContain('已停用');
      const o = await newOrder(ids.custA);
      const f = await as('finance').get(`/orders/${o.id}`).expect(200);
      expect(f.body).toMatchObject({ agentRateBp: 1000, parentRateBp: 0 });
      await as('finance').patch(`/agents/${ids.li}`, { status: 'ACTIVE' }).expect(200);
    });

    it('订单列表按代理筛选；代理详情列出自己的和下级的订单', async () => {
      const list = await as('finance').get(`/orders?agentId=${ids.zhou}`).expect(200);
      expect(list.body.total).toBe(3);
      const li = await as('finance').get(`/agents/${ids.li}`).expect(200);
      const roles = li.body.orders.map((o: { role: string }) => o.role);
      expect(roles.filter((r: string) => r === 'PARENT')).toHaveLength(3);
      const parentOrder = li.body.orders.find((o: { id: string }) => o.id === ids.orderA1) as {
        rateBp: number;
        agent: { name: string };
      };
      expect(parentOrder).toMatchObject({ rateBp: 300, agent: { name: '小周' } });
      const zhou = await as('finance').get(`/agents/${ids.zhou}`).expect(200);
      expect(zhou.body.customers.map((c: { name: string }) => c.name)).toEqual(['周的客户甲']);
      expect(zhou.body.customerCount).toBe(1);
    });

    it('写操作进操作日志', async () => {
      const logs = await as('admin').get('/audit-logs?action=agent.create').expect(200);
      expect(logs.body.total).toBe(3);
    });
  });
});
