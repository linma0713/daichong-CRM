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
type Who = 'admin' | 'sales' | 'zhang' | 'aftersales' | 'finance';

/**
 * M4 第三批：渠道台账、投放成本、渠道回报与成交漏斗、转介绍奖励、营销支出进财务、代理业绩
 */
describe('M4 渠道与营销', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const http = () => request(app.getHttpServer());
  const tokens = {} as Record<Who, string>;
  const ids: Record<string, string> = {};
  const today = localDateKey(new Date());
  const range = `from=${today}&to=${today}`;
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
  async function newCustomer(extra: object = {}, who: Who = 'sales') {
    seq++;
    const c = await as(who)
      .post('/customers', { name: `营销客户${seq}`, wechat: `m4c_${seq}`, ...extra })
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
        accountEmail: `m4c_${seq}@example.com`,
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
  const rewards = async (q = '') =>
    (await as('finance').get(`/referral-rewards${q}`).expect(200)).body;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "AuditLog", "Session", "UserRole", "User", "Role", "Team", "Customer",
        "FollowUp", "Plan", "Product", "Order", "Payment", "PaymentLink", "PaymentCallback", "ClaudeAccount", "Subscription",
        "FulfillmentTask", "Setting", "PaymentResource", "ResourceTransaction", "CostEntry",
        "Ticket", "TicketEvent", "Refund", "Agent", "Commission", "CommissionStatement",
        "Notification", "NotifyChannel", "OutboundMessage", "ScriptTemplate", "Channel",
        "ChannelCost", "ReferralReward"
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
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('渠道台账', () => {
    it('财务有「渠道与营销」权限；客服能看渠道列表但不能改', async () => {
      const me = await as('finance').get('/auth/me').expect(200);
      expect(me.body.permissions).toContain('marketing:write');
      await as('sales').post('/channels', { name: '小红书', platform: 'xiaohongshu' }).expect(403);
      expect((await as('sales').get('/channels').expect(200)).body).toEqual([]);
    });

    it('新增渠道，名称不能重复（不分大小写），平台必须是列表里的', async () => {
      const xhs = await as('finance')
        .post('/channels', { name: ' 小红书-主号 ', platform: 'xiaohongshu', note: '日更' })
        .expect(201);
      expect(xhs.body).toMatchObject({
        name: '小红书-主号',
        platform: 'xiaohongshu',
        enabled: true,
        customerCount: 0,
      });
      ids.xhs = xhs.body.id;
      const dy = await as('admin').post('/channels', { name: 'Douyin', platform: 'douyin' });
      expect(dy.status).toBe(201);
      ids.dy = dy.body.id;
      await as('finance').post('/channels', { name: 'douyin', platform: 'douyin' }).expect(400);
      await as('finance').post('/channels', { name: '某平台', platform: 'myspace' }).expect(400);
      await as('finance').patch(`/channels/${ids.dy}`, { name: '小红书-主号' }).expect(400);
      const tmp = await as('finance').post('/channels', { name: '录错了', platform: 'other' });
      await as('finance').delete(`/channels/${tmp.body.id}`).expect(200);
    });

    it('客户可以标渠道；停用的渠道不能再选，但已经标了的客户不受影响', async () => {
      ids.a1 = await newCustomer({ source: 'ads', channelId: ids.xhs });
      ids.a2 = await newCustomer({ source: 'ads', channelId: ids.xhs });
      ids.b1 = await newCustomer({ source: 'ads', channelId: ids.dy });
      ids.none = await newCustomer();
      const detail = await as('sales').get(`/customers/${ids.a1}`).expect(200);
      expect(detail.body.channel).toMatchObject({ id: ids.xhs, name: '小红书-主号' });

      const list = await as('sales').get(`/customers?channelId=${ids.xhs}`).expect(200);
      expect(list.body.items.map((c: { id: string }) => c.id).sort()).toEqual(
        [ids.a1, ids.a2].sort(),
      );
      const noneList = await as('sales').get('/customers?channelId=none').expect(200);
      expect(noneList.body.items.map((c: { id: string }) => c.id)).toEqual([ids.none]);

      await as('finance').patch(`/channels/${ids.dy}`, { enabled: false }).expect(200);
      await as('sales')
        .post('/customers', { name: '停用渠道客户', wechat: 'm4c_x', channelId: ids.dy })
        .expect(400);
      // 已标了停用渠道的客户，改别的字段照样能保存
      await as('sales')
        .patch(`/customers/${ids.b1}`, { remark: '改个备注', channelId: ids.dy })
        .expect(200);
      await as('finance').delete(`/channels/${ids.xhs}`).expect(400);
      const channels = (await as('sales').get('/channels').expect(200)).body;
      expect(channels.find((c: { id: string }) => c.id === ids.xhs).customerCount).toBe(2);
      await as('finance').patch(`/channels/${ids.dy}`, { enabled: true }).expect(200);
    });
  });

  describe('投放成本与渠道回报', () => {
    it('登记投放成本：金额大于 0，不能登记未来日期；客服看不到', async () => {
      await as('sales').get('/channel-costs').expect(403);
      await as('sales')
        .post('/channel-costs', { channelId: ids.xhs, spentOn: today, amountCents: 100 })
        .expect(403);
      await as('finance')
        .post('/channel-costs', { channelId: ids.xhs, spentOn: today, amountCents: 0 })
        .expect(400);
      await as('finance')
        .post('/channel-costs', {
          channelId: ids.xhs,
          spentOn: localDateKey(addDays(new Date(), 2)),
          amountCents: 100,
        })
        .expect(400);
      const c = await as('finance')
        .post('/channel-costs', {
          channelId: ids.xhs,
          spentOn: today,
          amountCents: 30000,
          note: '薯条加热',
        })
        .expect(201);
      expect(c.body).toMatchObject({
        channelName: '小红书-主号',
        spentOn: today,
        amountCents: 30000,
      });
      const wrong = await as('finance')
        .post('/channel-costs', { channelId: ids.dy, spentOn: today, amountCents: 999 })
        .expect(201);
      await as('finance').delete(`/channel-costs/${wrong.body.id}`).expect(200);
      await as('finance')
        .post('/channel-costs', {
          channelId: ids.dy,
          spentOn: localDateKey(addDays(new Date(), -40)),
          amountCents: 5000,
        })
        .expect(201);
      const list = await as('finance').get(`/channel-costs?from=${today}&to=${today}`).expect(200);
      expect(list.body.totalCents).toBe(30000);
      expect(list.body.items).toHaveLength(1);
      const all = await as('admin').get('/channel-costs').expect(200);
      expect(all.body.totalCents).toBe(35000);
      const channels = (await as('sales').get('/channels').expect(200)).body;
      expect(channels.find((c: { id: string }) => c.id === ids.dy).costCents).toBe(5000);
    });

    it('渠道回报：区间内建档的客户 → 成交 → 复购，收入按累计实付，获客成本 = 成本 ÷ 成交', async () => {
      await pay(ids.a1);
      await pay(ids.a1);
      await as('sales').get(`/marketing/channel-roi?${range}`).expect(403);
      const res = await as('finance').get(`/marketing/channel-roi?${range}`).expect(200);
      const xhs = res.body.byChannel.find((r: { key: string }) => r.key === ids.xhs);
      expect(xhs).toMatchObject({
        label: '小红书-主号',
        platform: 'xiaohongshu',
        leads: 2,
        converted: 1,
        repeat: 1,
        active: 1,
        conversionRate: 0.5,
        repeatRate: 1,
        revenueCents: 200000,
        costCents: 30000,
        cacCents: 30000,
      });
      expect(xhs.roi).toBeCloseTo((200000 - 30000) / 30000);
      const dy = res.body.byChannel.find((r: { key: string }) => r.key === ids.dy);
      // 40 天前的投放成本不在区间里
      expect(dy).toMatchObject({ leads: 1, converted: 0, costCents: 0, roi: null, cacCents: null });
      const none = res.body.byChannel.find((r: { key: string }) => r.key === 'none');
      expect(none).toMatchObject({ label: '未标渠道', leads: 1, costCents: 0, roi: null });
      expect(res.body.total).toMatchObject({ leads: 4, converted: 1, costCents: 30000 });
      const ads = res.body.bySource.find((r: { key: string }) => r.key === 'ads');
      expect(ads).toMatchObject({ label: '投放', leads: 3, converted: 1 });
      expect(res.body.partialScope).toBe(false);
      await as('finance').get('/marketing/channel-roi?from=2026-11-20&to=2026-11-01').expect(400);
    });
  });

  describe('转介绍奖励', () => {
    it('奖励金额默认 0：推荐的新客户成交也不生成奖励', async () => {
      const settings = await as('admin').get('/settings').expect(200);
      expect(settings.body.referralRewardCents).toBe(0);
      ids.r0 = await newCustomer({ source: 'referral', referrerId: ids.a1 });
      await pay(ids.r0);
      expect((await rewards()).total).toBe(0);
    });

    it('设置奖励金额后：新客户首单收齐款，给推荐人生成待发放奖励，并通知财务', async () => {
      await as('sales').patch('/settings', { referralRewardCents: 5000 }).expect(403);
      await as('admin').patch('/settings', { referralRewardCents: -1 }).expect(400);
      await as('admin').patch('/settings', { referralRewardCents: 5000 }).expect(200);
      ids.r1 = await newCustomer({ source: 'referral', referrerId: ids.a1 });
      const order = await pay(ids.r1);
      const list = await rewards();
      expect(list).toMatchObject({ total: 1, pendingCents: 5000, pendingCount: 1 });
      expect(list.items[0]).toMatchObject({
        code: 'Y00001',
        status: 'PENDING',
        amountCents: 5000,
        orderId: order.id,
        referrer: { id: ids.a1 },
        referee: { id: ids.r1 },
      });
      ids.reward1 = list.items[0].id;
      // 第二单不再生成
      await pay(ids.r1);
      expect((await rewards()).total).toBe(1);
      // 之前已经成交过的被推荐客户（r0）再下单也不补
      await pay(ids.r0);
      expect((await rewards()).total).toBe(1);

      const inbox = (await as('finance').get('/notifications').expect(200)).body;
      const note = inbox.items.find((n: { event: string }) => n.event === 'referral.created');
      expect(note).toMatchObject({ link: '/marketing?tab=rewards' });
      expect(note.title).toContain('Y00001');
      const salesInbox = (await as('sales').get('/notifications').expect(200)).body;
      expect(salesInbox.items.some((n: { event: string }) => n.event === 'referral.created')).toBe(
        false,
      );

      const detail = await as('sales').get(`/customers/${ids.a1}`).expect(200);
      expect(detail.body.referrals).toEqual({
        referred: 2,
        converted: 2,
        pendingCents: 5000,
        paidCents: 0,
      });
    });

    it('发放：现金发放进营销支出；抵扣续费的不重复算；只能发一次', async () => {
      await as('sales').get('/referral-rewards').expect(403);
      await as('sales')
        .post(`/referral-rewards/${ids.reward1}/pay`, { method: 'alipay' })
        .expect(403);
      await as('finance')
        .post(`/referral-rewards/${ids.reward1}/pay`, { method: 'cash' })
        .expect(400);
      await as('finance')
        .post(`/referral-rewards/${ids.reward1}/pay`, {
          method: 'alipay',
          paidAt: addDays(new Date(), 3).toISOString(),
        })
        .expect(400);
      const paid = await as('finance')
        .post(`/referral-rewards/${ids.reward1}/pay`, { method: 'alipay', reference: 'ZFB001' })
        .expect(200);
      expect(paid.body).toMatchObject({
        status: 'PAID',
        method: 'alipay',
        reference: 'ZFB001',
        paidBy: { id: ids.finance },
      });
      await as('finance')
        .post(`/referral-rewards/${ids.reward1}/pay`, { method: 'alipay' })
        .expect(400);
      await as('finance')
        .post(`/referral-rewards/${ids.reward1}/cancel`, { reason: '晚了' })
        .expect(400);

      ids.r2 = await newCustomer({ source: 'referral', referrerId: ids.a2 });
      await pay(ids.r2);
      const r2 = (await rewards('?status=PENDING')).items[0];
      expect(r2.referee.id).toBe(ids.r2);
      await as('finance')
        .post(`/referral-rewards/${r2.id}/pay`, { method: 'discount', reference: '下次续费减 50' })
        .expect(200);

      const report = (await as('finance').get(`/finance/report?${range}`).expect(200)).body;
      expect(report.totals.marketingCents).toBe(30000 + 5000);
      expect(report.totals.operatingProfitCents).toBe(report.totals.profitCents - 35000);
      const journal = (await as('finance').get(`/finance/journal?${range}`).expect(200)).body;
      const marketing = journal.items.filter((e: { kind: string }) => e.kind === 'marketing');
      expect(
        marketing.map((e: { category: string; amountCents: number }) => [
          e.category,
          e.amountCents,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ['投放成本', -30000],
          ['转介绍奖励', -5000],
        ]),
      );
      expect(marketing).toHaveLength(2);
      const reward = marketing.find((e: { category: string }) => e.category === '转介绍奖励');
      expect(reward.customer.id).toBe(ids.a1);
      expect(reward.reference).toContain('ZFB001');

      const detail = await as('admin').get(`/customers/${ids.a1}`).expect(200);
      expect(detail.body.referrals).toMatchObject({ pendingCents: 0, paidCents: 5000 });
    });

    it('作废要填原因；首单全额退款自动作废还没发的奖励', async () => {
      ids.r3 = await newCustomer({ source: 'referral', referrerId: ids.a2 });
      await pay(ids.r3);
      const r3 = (await rewards('?status=PENDING')).items[0];
      await as('finance').post(`/referral-rewards/${r3.id}/cancel`, { reason: ' ' }).expect(400);
      const cancelled = await as('finance')
        .post(`/referral-rewards/${r3.id}/cancel`, { reason: '推荐人说不用了' })
        .expect(200);
      expect(cancelled.body).toMatchObject({ status: 'CANCELLED', cancelReason: '推荐人说不用了' });

      ids.r4 = await newCustomer({ source: 'referral', referrerId: ids.a2 });
      const order = await pay(ids.r4);
      const r4 = (await rewards('?status=PENDING')).items[0];
      expect(r4.referee.id).toBe(ids.r4);
      // 部分退款不动
      const part = await as('aftersales')
        .post('/refunds', { orderId: order.id, amountCents: 10000, reason: '少开了几天' })
        .expect(201);
      await as('finance')
        .post(`/refunds/${part.body.id}/approve`, { method: 'wechat' })
        .expect(200);
      expect((await rewards('?status=PENDING')).items[0].id).toBe(r4.id);
      const rest = await as('aftersales')
        .post('/refunds', { orderId: order.id, amountCents: 90000, reason: '不要了' })
        .expect(201);
      await as('finance')
        .post(`/refunds/${rest.body.id}/approve`, { method: 'wechat' })
        .expect(200);
      const after = (await rewards(`?referrerId=${ids.a2}`)).items.find(
        (r: { id: string }) => r.id === r4.id,
      );
      expect(after).toMatchObject({ status: 'CANCELLED', cancelReason: '新客户首单已全额退款' });
      expect((await rewards()).pendingCount).toBe(0);
    });
  });

  describe('经营数据', () => {
    it('代理业绩：区间内新绑定客户、收齐款订单、首单、实收和佣金；客户分层快照', async () => {
      const agent = await as('finance').post('/agents', { name: '老李' }).expect(201);
      const c = await newCustomer({ agentId: agent.body.id });
      await pay(c);
      await pay(c);
      await newCustomer({ agentId: agent.body.id });
      await as('sales').get('/analytics').expect(403);
      const res = (await as('admin').get('/analytics?days=7').expect(200)).body;
      expect(res.agents).toEqual([
        expect.objectContaining({
          agentId: agent.body.id,
          code: 'A00001',
          name: '老李',
          newCustomers: 2,
          paidOrders: 2,
          firstOrders: 1,
          salesCents: 200000,
        }),
      ]);
      const stages = Object.fromEntries(
        res.segments.stages.map((s: { stage: string; count: number }) => [s.stage, s.count]),
      );
      expect(Object.keys(stages)).toEqual(['LEAD', 'NEW', 'ACTIVE', 'DORMANT', 'CHURNED']);
      expect(stages.NEW).toBeGreaterThan(0);
      expect(stages.LEAD).toBeGreaterThan(0);
    });
  });
});
