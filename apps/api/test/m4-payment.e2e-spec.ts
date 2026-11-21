import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { runSeed } from '../prisma/seed';
import { OnlinePaymentService } from '../src/payments/online';

const PASSWORD = 'Crm2026test';
type Who = 'admin' | 'sales' | 'sales2' | 'aftersales' | 'finance';

/**
 * M4 第七批：在线收款（模拟通道）。收款链接 → 客户付款页 → 回调验签 → 自动确认收款 → 派开通任务；
 * 重复通知、金额不符、订单已取消时到账、过期、关闭、手工收款后链接作废
 */
describe('M4 在线收款', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let online: OnlinePaymentService;
  const http = () => request(app.getHttpServer());
  const tokens = {} as Record<Who, string>;
  const ids: Record<string, string> = {};
  // 付款页接口按 IP 限流，每个请求换一个来源 IP
  let ipSeq = 0;
  const ip = () => `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;
  const as = (who: Who) => ({
    get: (url: string) => http().get(`/api${url}`).auth(tokens[who], { type: 'bearer' }),
    post: (url: string, body: object = {}) =>
      http().post(`/api${url}`).auth(tokens[who], { type: 'bearer' }).send(body),
    patch: (url: string, body: object = {}) =>
      http().patch(`/api${url}`).auth(tokens[who], { type: 'bearer' }).send(body),
  });
  const pub = {
    get: (token: string) => http().get(`/api/pay/${token}`).set('X-Forwarded-For', ip()),
    mockPay: (token: string) =>
      http().post(`/api/pay/${token}/mock-pay`).set('X-Forwarded-For', ip()),
    notify: (channel: string, body: object) =>
      http().post(`/api/pay/notify/${channel}`).set('X-Forwarded-For', ip()).send(body),
  };
  const tokenOf = (link: { payPath: string }) => link.payPath.replace('/pay/', '');

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
      .set('X-Forwarded-For', ip())
      .send({ username, password: PASSWORD })
      .expect(200);
    return { id: user.id, token: res.body.accessToken as string };
  }

  let seq = 0;
  async function newOrder(who: Who = 'sales') {
    seq++;
    const c = await as(who)
      .post('/customers', { name: `付款客户${seq}`, wechat: `pay_${seq}` })
      .expect(201);
    const order = await as(who)
      .post('/orders', {
        customerId: c.body.id,
        kind: 'NEW',
        productId: ids.product,
        accountEmail: `pay_${seq}@example.com`,
      })
      .expect(201);
    return order.body as { id: string; code: string; amountCents: number };
  }
  const detail = async (orderId: string, who: Who = 'sales') =>
    (await as(who).get(`/orders/${orderId}`).expect(200)).body;
  const setChannel = (onlinePayChannel: string) =>
    as('admin').patch('/settings', { onlinePayChannel }).expect(200);

  beforeAll(async () => {
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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    online = app.get(OnlinePaymentService);

    const admin = await http()
      .post('/api/auth/login')
      .set('X-Forwarded-For', ip())
      .send({ username: 'admin', password: PASSWORD })
      .expect(200);
    tokens.admin = admin.body.accessToken;
    for (const [key, name, role] of [
      ['sales', '客服小王', 'sales'],
      ['sales2', '客服小赵', 'sales'],
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
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('开启与权限', () => {
    it('默认不开启，生成链接提示先去设置', async () => {
      const s = await as('sales').get('/settings').expect(200);
      expect(s.body).toMatchObject({
        onlinePayChannel: 'off',
        payLinkMinutes: 30,
        payShopName: '',
      });
      const order = await newOrder();
      ids.order1 = order.id;
      const res = await as('sales').post(`/orders/${order.id}/payment-links`).expect(400);
      expect(res.body.message).toContain('还没开启在线收款');
    });

    it('管理员选模拟通道；只认列表里的通道，有效期 5～1440 分钟', async () => {
      await as('admin').patch('/settings', { onlinePayChannel: 'alipay' }).expect(400);
      await as('admin').patch('/settings', { payLinkMinutes: 3 }).expect(400);
      await as('sales').patch('/settings', { onlinePayChannel: 'mock' }).expect(403);
      const s = await as('admin')
        .patch('/settings', {
          onlinePayChannel: 'mock',
          payLinkMinutes: 60,
          payShopName: '  小林代充  ',
        })
        .expect(200);
      expect(s.body).toMatchObject({
        onlinePayChannel: 'mock',
        payLinkMinutes: 60,
        payShopName: '小林代充',
      });
    });

    it('售后（只能看订单）不能生成链接；别的客服看不到这单', async () => {
      await as('aftersales').post(`/orders/${ids.order1}/payment-links`).expect(403);
      await as('sales2').post(`/orders/${ids.order1}/payment-links`).expect(404);
    });
  });

  describe('收款链接', () => {
    it('默认金额是订单还差的钱，编号 P00001，有效期按设置', async () => {
      const before = Date.now();
      const res = await as('sales').post(`/orders/${ids.order1}/payment-links`).expect(201);
      expect(res.body).toMatchObject({
        code: 'P00001',
        channel: 'mock',
        amountCents: 100000,
        status: 'PENDING',
        payUrl: null,
        anomaly: null,
        createdBy: { id: ids.sales },
      });
      expect(res.body.payPath).toMatch(/^\/pay\/[A-Za-z0-9_-]{43}$/);
      const minutes = (new Date(res.body.expiresAt).getTime() - before) / 60_000;
      expect(minutes).toBeGreaterThan(59);
      expect(minutes).toBeLessThan(61);
      ids.link1 = res.body.id;
      ids.token1 = tokenOf(res.body);
      const d = await detail(ids.order1);
      expect(d.paymentLinks).toHaveLength(1);
      expect(d.paymentLinks[0]).toMatchObject({ code: 'P00001', status: 'PENDING' });
    });

    it('金额不能超过还差的钱', async () => {
      const res = await as('sales')
        .post(`/orders/${ids.order1}/payment-links`, { amountCents: 100001 })
        .expect(400);
      expect(res.body.message).toContain('超过');
    });

    it('付款页不用登录，只给订单号、商品、金额，不带客户信息', async () => {
      const res = await pub.get(ids.token1).expect(200);
      expect(res.body).toMatchObject({
        shopName: '小林代充',
        orderCode: 'D00001',
        amountCents: 100000,
        status: 'PENDING',
        channel: 'mock',
        mock: true,
        payUrl: null,
      });
      expect(Object.keys(res.body).sort()).toEqual(
        [
          'amountCents',
          'channel',
          'expiresAt',
          'mock',
          'orderCode',
          'paidAt',
          'payUrl',
          'productName',
          'shopName',
          'status',
        ].sort(),
      );
      expect(JSON.stringify(res.body)).not.toContain('付款客户');
      await pub.get('not-a-real-token-but-long-enough-xx').expect(404);
      await pub.get('short').expect(404);
    });

    it('再生成一条（只收一部分），之前那条作废，客户点旧链接付不了', async () => {
      const res = await as('sales')
        .post(`/orders/${ids.order1}/payment-links`, { amountCents: 30000 })
        .expect(201);
      expect(res.body).toMatchObject({ code: 'P00002', amountCents: 30000 });
      ids.link2 = res.body.id;
      ids.token2 = tokenOf(res.body);
      const old = await as('sales').get(`/payment-links/${ids.link1}`).expect(200);
      expect(old.body.status).toBe('CLOSED');
      const pay = await pub.mockPay(ids.token1).expect(400);
      expect(pay.body.message).toContain('失效');
    });

    it('模拟付款成功：自动记一笔收款，记在发链接的客服名下，通知负责客服', async () => {
      const res = await pub.mockPay(ids.token2).expect(200);
      expect(res.body.status).toBe('PAID');
      expect(res.body.paidAt).toBeTruthy();
      const d = await detail(ids.order1);
      expect(d.status).toBe('PENDING_PAYMENT');
      expect(d.paidCents).toBe(30000);
      expect(d.payments).toHaveLength(1);
      expect(d.payments[0]).toMatchObject({
        amountCents: 30000,
        method: 'other',
        channel: 'mock',
        reference: '在线收款 P00002',
        confirmedBy: { id: ids.sales },
      });
      expect(d.paymentLinks[0]).toMatchObject({ code: 'P00002', status: 'PAID', anomaly: null });
      const n = await prisma.notification.findFirst({
        where: { userId: ids.sales, event: 'payment.received' },
      });
      expect(n?.body).toContain('在线收款（模拟通道）');
      expect(n?.body).toContain('还差 ¥700.00');
      const cb = await prisma.paymentCallback.findMany({ where: { linkId: ids.link2 } });
      expect(cb).toHaveLength(1);
      expect(cb[0]).toMatchObject({ channel: 'mock', ok: true, result: '已到账，已自动确认收款' });
    });

    it('同一条链接再点一次不会重复记账', async () => {
      const res = await pub.mockPay(ids.token2).expect(200);
      expect(res.body.status).toBe('PAID');
      const payments = await prisma.payment.count({ where: { orderId: ids.order1 } });
      expect(payments).toBe(1);
    });

    it('付清剩下的：订单转开通中，自动派开通任务', async () => {
      const res = await as('sales').post(`/orders/${ids.order1}/payment-links`).expect(201);
      expect(res.body.amountCents).toBe(70000);
      await pub.mockPay(tokenOf(res.body)).expect(200);
      const d = await detail(ids.order1);
      expect(d.status).toBe('FULFILLING');
      expect(d.paidCents).toBe(100000);
      expect(d.tasks).toHaveLength(1);
      expect(d.tasks[0].type).toBe('ACTIVATE');
      // 订单收齐后不能再发链接
      await as('sales').post(`/orders/${ids.order1}/payment-links`).expect(400);
    });

    it('操作日志里有生成链接和到账两条', async () => {
      const logs = await prisma.auditLog.findMany({
        where: { action: { in: ['payment_link.create', 'payment_link.paid'] } },
      });
      expect(logs.filter((l) => l.action === 'payment_link.create')).toHaveLength(3);
      const paid = logs.filter((l) => l.action === 'payment_link.paid');
      expect(paid).toHaveLength(2);
      expect(paid[0]).toMatchObject({ userId: null, resourceId: ids.order1 });
    });
  });

  describe('支付平台回调', () => {
    it('签名不对、未知通道、找不到链接都拒绝，并留下回调记录', async () => {
      const order = await newOrder();
      const link = (await as('sales').post(`/orders/${order.id}/payment-links`).expect(201)).body;
      const notice = online.mock.buildNotice(link.code, link.amountCents);
      await pub.notify('mock', { ...notice, sign: 'f'.repeat(64) }).expect(400);
      await pub.notify('mock', { ...notice, amountCents: 1 }).expect(400);
      await pub.notify('alipay', notice).expect(404);
      await pub.notify('mock', online.mock.buildNotice('P09999', link.amountCents)).expect(400);
      const failed = await prisma.paymentCallback.findMany({
        where: { ok: false },
        orderBy: { createdAt: 'asc' },
      });
      expect(failed.map((c) => c.result)).toEqual([
        '验签失败：签名不对',
        '验签失败：签名不对',
        '未知的收款通道',
        '找不到收款链接 P09999',
      ]);
      expect((await detail(order.id)).paidCents).toBe(0);

      // 正确的通知：记账；平台重发同一条也只记一次
      await pub.notify('mock', notice).expect(200);
      await pub.notify('mock', notice).expect(200);
      const d = await detail(order.id);
      expect(d.status).toBe('FULFILLING');
      expect(d.payments).toHaveLength(1);
      const last = await prisma.paymentCallback.findFirst({ orderBy: { createdAt: 'desc' } });
      expect(last).toMatchObject({ ok: true, result: '重复通知，之前已经处理过' });
    });

    it('链接过期后才到账：订单还在待收款就照样记账', async () => {
      const order = await newOrder();
      const link = (await as('sales').post(`/orders/${order.id}/payment-links`).expect(201)).body;
      await prisma.paymentLink.update({
        where: { id: link.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      await pub.notify('mock', online.mock.buildNotice(link.code, link.amountCents)).expect(200);
      expect((await detail(order.id)).status).toBe('FULFILLING');
    });

    it('订单取消后才到账：链接标成已付款、不记账，通知负责客服和财务去核对退款', async () => {
      const order = await newOrder();
      const link = (await as('sales').post(`/orders/${order.id}/payment-links`).expect(201)).body;
      await as('sales').post(`/orders/${order.id}/cancel`, { reason: '客户不要了' }).expect(200);
      expect((await as('sales').get(`/payment-links/${link.id}`).expect(200)).body.status).toBe(
        'CLOSED',
      );
      // 模拟通道的付款页上已经付不了
      await pub.mockPay(tokenOf(link)).expect(400);
      // 但真实通道里客户可能早就付了，回调晚到
      await pub.notify('mock', online.mock.buildNotice(link.code, link.amountCents)).expect(200);
      const d = await detail(order.id);
      expect(d.status).toBe('CANCELLED');
      expect(d.paidCents).toBe(0);
      expect(d.paymentLinks[0]).toMatchObject({ status: 'PAID', anomaly: '订单已经取消' });
      for (const who of ['sales', 'finance'] as const) {
        const n = await prisma.notification.findFirst({
          where: { userId: ids[who], event: 'payment.anomaly' },
        });
        expect(n?.title).toContain('没有自动记账');
        expect(n?.body).toContain('订单已经取消');
        expect(n?.link).toBe(`/orders/${order.id}`);
      }
    });

    it('到账金额和链接对不上：不记账，标出原因', async () => {
      const order = await newOrder();
      const link = (await as('sales').post(`/orders/${order.id}/payment-links`).expect(201)).body;
      await pub.notify('mock', online.mock.buildNotice(link.code, 50000)).expect(200);
      const d = await detail(order.id);
      expect(d.paidCents).toBe(0);
      expect(d.paymentLinks[0].anomaly).toContain('不一致');
    });

    it('回调内容太大只存开头', async () => {
      await pub.notify('mock', { junk: 'x'.repeat(20_000) }).expect(400);
      const last = await prisma.paymentCallback.findFirst({ orderBy: { createdAt: 'desc' } });
      expect(last?.payload).toMatchObject({ length: expect.any(Number) });
      expect(JSON.stringify(last?.payload).length).toBeLessThan(3_000);
    });
  });

  describe('作废与过期', () => {
    it('手工确认收款后，等付款的链接自动关闭', async () => {
      const order = await newOrder();
      const link = (await as('sales').post(`/orders/${order.id}/payment-links`).expect(201)).body;
      await as('sales')
        .post(`/orders/${order.id}/payments`, { amountCents: 10000, method: 'wechat' })
        .expect(200);
      const d = await detail(order.id);
      expect(d.paymentLinks[0]).toMatchObject({ id: link.id, status: 'CLOSED' });
      expect(d.payments[0].channel).toBeNull();
    });

    it('员工手动关闭；已付款的不能关', async () => {
      const order = await newOrder();
      const link = (await as('sales').post(`/orders/${order.id}/payment-links`).expect(201)).body;
      await as('aftersales').post(`/payment-links/${link.id}/close`).expect(403);
      const res = await as('sales').post(`/payment-links/${link.id}/close`).expect(200);
      expect(res.body.status).toBe('CLOSED');
      expect(res.body.closedAt).toBeTruthy();
      expect((await pub.get(tokenOf(link)).expect(200)).body.status).toBe('CLOSED');

      const link2 = (await as('sales').post(`/orders/${order.id}/payment-links`).expect(201)).body;
      await pub.mockPay(tokenOf(link2)).expect(200);
      const closePaid = await as('sales').post(`/payment-links/${link2.id}/close`).expect(400);
      expect(closePaid.body.message).toContain('已经付款');
    });

    it('过了有效期：付款页显示已过期、不能付；定时任务落库', async () => {
      const order = await newOrder();
      const link = (await as('sales').post(`/orders/${order.id}/payment-links`).expect(201)).body;
      await prisma.paymentLink.update({
        where: { id: link.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await pub.get(tokenOf(link)).expect(200)).body.status).toBe('EXPIRED');
      expect((await as('sales').get(`/payment-links/${link.id}`).expect(200)).body.status).toBe(
        'EXPIRED',
      );
      const pay = await pub.mockPay(tokenOf(link)).expect(400);
      expect(pay.body.message).toContain('过期');
      expect(await online.expire()).toBeGreaterThanOrEqual(1);
      const row = await prisma.paymentLink.findUniqueOrThrow({ where: { id: link.id } });
      expect(row.status).toBe('EXPIRED');
    });

    it('管理员关掉模拟通道后，已发出的模拟链接立刻付不了', async () => {
      const order = await newOrder();
      const link = (await as('sales').post(`/orders/${order.id}/payment-links`).expect(201)).body;
      await setChannel('off');
      const res = await pub.mockPay(tokenOf(link)).expect(400);
      expect(res.body.message).toContain('模拟通道已经关闭');
      expect((await detail(order.id)).paidCents).toBe(0);
      await setChannel('mock');
    });
  });
});
