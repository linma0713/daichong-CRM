import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { addDays, addHours, parseLocalDate, localDateKey } from '../src/common/dates';
import { NotifyDispatcher, WecomSender } from '../src/notify/notify';
import { NotifyScanService } from '../src/scheduler/notify-scan';
import { runSeed } from '../prisma/seed';

const PASSWORD = 'Crm2026test';
const WEBHOOK =
  'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';
type Who = 'admin' | 'sales' | 'zhang' | 'liu' | 'aftersales' | 'finance';

/**
 * M4 第一批：站内消息、企业微信群机器人（outbox + 重试）、在班轮流派单、消息巡检（超时、库存、早报）
 */
describe('M4 消息与自动化', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let dispatcher: NotifyDispatcher;
  let scan: NotifyScanService;
  let send: jest.SpyInstance;
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
  /** 客服下单并收齐款，返回订单详情（含刚生成的开通任务） */
  async function paidOrder() {
    seq++;
    const c = await as('sales')
      .post('/customers', { name: `客户${seq}`, wechat: `m4n_${seq}` })
      .expect(201);
    const order = await as('sales')
      .post('/orders', {
        customerId: c.body.id,
        kind: 'NEW',
        productId: ids.product,
        accountEmail: `m4n_${seq}@example.com`,
      })
      .expect(201);
    const paid = await as('sales')
      .post(`/orders/${order.body.id}/payments`, {
        amountCents: order.body.amountCents,
        method: 'wechat',
      })
      .expect(200);
    return paid.body;
  }
  const taskOf = (orderId: string) =>
    prisma.fulfillmentTask.findFirstOrThrow({ where: { orderId } });
  const inbox = async (who: Who) => (await as(who).get('/notifications').expect(200)).body;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "AuditLog", "Session", "UserRole", "User", "Role", "Team", "Customer",
        "FollowUp", "Plan", "Product", "Order", "Payment", "ClaudeAccount", "Subscription",
        "FulfillmentTask", "Setting", "PaymentResource", "ResourceTransaction", "CostEntry",
        "Ticket", "TicketEvent", "Refund", "Agent", "Commission", "CommissionStatement",
        "Notification", "NotifyChannel", "OutboundMessage"
        RESTART IDENTITY CASCADE`);
    await runSeed(prisma, { adminUsername: 'admin', adminPassword: PASSWORD });
    await prisma.user.updateMany({ data: { mustChangePassword: false } });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    dispatcher = app.get(NotifyDispatcher);
    scan = app.get(NotifyScanService);
    send = jest.spyOn(app.get(WecomSender), 'send').mockResolvedValue(undefined);

    const admin = await http()
      .post('/api/auth/login')
      .send({ username: 'admin', password: PASSWORD })
      .expect(200);
    tokens.admin = admin.body.accessToken;
    for (const [key, name, role] of [
      ['sales', '客服小王', 'sales'],
      ['zhang', '充值员小张', 'fulfillment'],
      ['liu', '充值员小刘', 'fulfillment'],
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
        priceCents: 20000,
      })
      .expect(201);
    ids.product = p.body.id;
    const card = await as('admin')
      .post('/resources', {
        type: 'VIRTUAL_CARD',
        name: '测试卡',
        initialUsdCents: 100000,
        initialCnyCents: 720000,
        lowBalanceUsdCents: 5000,
      })
      .expect(201);
    ids.card = card.body.id;
  });

  afterAll(async () => {
    await prisma.notifyChannel.deleteMany();
    await app.close();
    await prisma.$disconnect();
  });

  describe('在班派单', () => {
    it('没人在班时照旧在所有充值员里派，负载相同就轮流', async () => {
      const a = await paidOrder();
      const b = await paidOrder();
      const assignees = [(await taskOf(a.id)).assigneeId, (await taskOf(b.id)).assigneeId];
      expect(new Set(assignees)).toEqual(new Set([ids.zhang, ids.liu]));
    });

    it('只有客服、售后不能上下班', async () => {
      await as('sales').get('/tasks/duty').expect(403);
      await as('aftersales').post('/tasks/duty', { onDuty: true }).expect(403);
    });

    it('有人在班时只派给在班的人', async () => {
      const r = await as('zhang').post('/tasks/duty', { onDuty: true }).expect(200);
      expect(r.body.onDuty).toBe(true);
      expect(r.body.dispatchable).toBe(true);
      expect(r.body.staff.map((s: { displayName: string }) => s.displayName)).toEqual([
        '充值员小张',
        '充值员小刘',
      ]);
      for (let i = 0; i < 3; i++) {
        const o = await paidOrder();
        expect((await taskOf(o.id)).assigneeId).toBe(ids.zhang);
      }
      const duty = await as('liu').get('/tasks/duty').expect(200);
      expect(duty.body.onDuty).toBe(false);
      expect(duty.body.staff.find((s: { id: string }) => s.id === ids.zhang).open).toBe(4);
    });

    it('下班：还没开始的任务转给在班的同事，处理中的留在手上', async () => {
      const o = await paidOrder();
      const started = await taskOf(o.id);
      await as('zhang').post(`/tasks/${started.id}/claim`).expect(200);
      await as('liu').post('/tasks/duty', { onDuty: true }).expect(200);
      const r = await as('zhang').post('/tasks/duty', { onDuty: false }).expect(200);
      expect(r.body.moved).toBe(4);
      const zhangOpen = await prisma.fulfillmentTask.findMany({
        where: { assigneeId: ids.zhang, status: { in: ['PENDING', 'IN_PROGRESS'] } },
      });
      expect(zhangOpen.map((t) => t.id)).toEqual([started.id]);
      const liuInbox = await inbox('liu');
      expect(liuInbox.items.some((n: { event: string }) => n.event === 'task.assigned')).toBe(true);
    });

    it('最后一个在班的人下班：没开始的任务放回任务池；有人上班时再派出去', async () => {
      const r = await as('liu').post('/tasks/duty', { onDuty: false }).expect(200);
      expect(r.body.moved).toBeGreaterThan(0);
      const pool = await prisma.fulfillmentTask.count({
        where: { status: 'PENDING', assigneeId: null },
      });
      expect(pool).toBe(r.body.moved);
      const on = await as('zhang').post('/tasks/duty', { onDuty: true }).expect(200);
      expect(on.body.moved).toBe(pool);
      expect(
        await prisma.fulfillmentTask.count({ where: { status: 'PENDING', assigneeId: null } }),
      ).toBe(0);
    });
  });

  describe('站内消息', () => {
    it('新任务通知派到的充值员；未读数、标记已读、全部已读', async () => {
      await prisma.notification.deleteMany();
      const o = await paidOrder();
      const task = await taskOf(o.id);
      expect(task.assigneeId).toBe(ids.zhang);
      const box = await inbox('zhang');
      expect(box.unread).toBe(1);
      expect(box.items[0]).toMatchObject({ event: 'task.created', readAt: null });
      expect(box.items[0].title).toContain('新开通');
      expect(box.items[0].body).toContain('客户');
      expect(box.items[0].link).toContain('/tasks?view=open&keyword=T');
      // 别人看不到
      expect((await inbox('liu')).items.some((n: { id: string }) => n.id === box.items[0].id)).toBe(
        false,
      );
      await as('liu').post(`/notifications/${box.items[0].id}/read`).expect(200);
      expect((await as('zhang').get('/notifications/unread-count').expect(200)).body.unread).toBe(
        1,
      );
      await as('zhang').post(`/notifications/${box.items[0].id}/read`).expect(200);
      expect((await as('zhang').get('/notifications/unread-count').expect(200)).body.unread).toBe(
        0,
      );
      await paidOrder();
      await as('zhang').post('/notifications/read-all').expect(200);
      expect((await as('zhang').get('/notifications?unreadOnly=true').expect(200)).body.total).toBe(
        0,
      );
    });

    it('开通完成通知负责的客服；失败通知客服并带原因；自己操作的不通知自己', async () => {
      const o = await paidOrder();
      const task = await taskOf(o.id);
      await as('zhang').post(`/tasks/${task.id}/fail`, { note: '客户的号被锁了' }).expect(200);
      let box = await inbox('sales');
      expect(box.items[0]).toMatchObject({ event: 'task.failed', link: `/orders/${o.id}` });
      expect(box.items[0].body).toContain('客户的号被锁了');
      await as('zhang').post(`/tasks/${task.id}/complete`, { resourceId: ids.card }).expect(200);
      box = await inbox('sales');
      expect(box.items[0].event).toBe('task.done');
      expect(box.items[0].title).toContain('可以交付客户');
      expect(
        (await inbox('zhang')).items.some((n: { event: string }) => n.event === 'task.done'),
      ).toBe(false);
    });

    it('别人代确认收款时通知负责客服', async () => {
      const c = await as('sales')
        .post('/customers', { name: '代收客户', wechat: 'm4n_pay' })
        .expect(201);
      const order = await as('sales')
        .post('/orders', {
          customerId: c.body.id,
          kind: 'NEW',
          productId: ids.product,
          accountEmail: 'm4n_pay@example.com',
        })
        .expect(201);
      await as('admin')
        .post(`/orders/${order.body.id}/payments`, { amountCents: 5000, method: 'alipay' })
        .expect(200);
      const n = (await inbox('sales')).items[0];
      expect(n.event).toBe('payment.received');
      expect(n.body).toContain('还差 ¥150.00');
    });

    it('新工单通知售后；退款申请通知有审批权限的财务（不是管理员）；审批结果通知申请人', async () => {
      const o = await paidOrder();
      const t = await as('sales')
        .post('/tickets', {
          customerId: o.customer.id,
          type: 'OTHER',
          description: '客户问能不能换邮箱',
        })
        .expect(201);
      const after = await inbox('aftersales');
      expect(after.items[0]).toMatchObject({
        event: 'ticket.created',
        link: `/tickets/${t.body.id}`,
      });

      const r = await as('aftersales')
        .post('/refunds', {
          orderId: o.id,
          amountCents: 1000,
          reason: '协商退一点',
          terminate: false,
        })
        .expect(201);
      const fin = await inbox('finance');
      expect(fin.items[0].event).toBe('refund.requested');
      expect(fin.items[0].title).toContain('¥10.00');
      expect(
        (await inbox('admin')).items.some((n: { event: string }) => n.event === 'refund.requested'),
      ).toBe(false);

      await as('finance')
        .post(`/refunds/${r.body.id}/reject`, { reason: '金额没谈好' })
        .expect(200);
      const back = await inbox('aftersales');
      expect(back.items[0].event).toBe('refund.decided');
      expect(back.items[0].title).toContain('被驳回');
    });

    it('没有专人负责的事件发给管理员（库存预警）', async () => {
      await prisma.paymentResource.update({
        where: { id: ids.card },
        data: { balanceUsdCents: 1000 },
      });
      const r = await scan.run();
      expect(r.inventoryAlerts).toBe(1);
      const n = (await inbox('admin')).items[0];
      expect(n.event).toBe('inventory.low');
      expect(n.body).toContain('测试卡');
      // 没恢复之前不重复提醒
      expect((await scan.run()).inventoryAlerts).toBe(0);
      await prisma.paymentResource.update({
        where: { id: ids.card },
        data: { balanceUsdCents: 90000 },
      });
      expect((await scan.run()).inventoryAlerts).toBe(0);
      await prisma.paymentResource.update({
        where: { id: ids.card },
        data: { balanceUsdCents: 2000 },
      });
      expect((await scan.run()).inventoryAlerts).toBe(1);
      await prisma.paymentResource.update({
        where: { id: ids.card },
        data: { balanceUsdCents: 90000 },
      });
    });

    it('任务超时提醒一次；很久以前就超时的老任务静默跳过', async () => {
      const fresh = await taskOf((await paidOrder()).id);
      const old = await taskOf((await paidOrder()).id);
      await prisma.fulfillmentTask.update({
        where: { id: fresh.id },
        data: { dueAt: addHours(new Date(), -1) },
      });
      await prisma.fulfillmentTask.update({
        where: { id: old.id },
        data: { dueAt: addDays(new Date(), -10) },
      });
      const r = await scan.run();
      expect(r.overdueTasks).toBe(1);
      const n = (await inbox('zhang')).items.find(
        (x: { event: string }) => x.event === 'task.overdue',
      );
      expect(n.title).toContain('已超时');
      expect((await scan.run()).overdueTasks).toBe(0);
      expect(
        (await prisma.fulfillmentTask.findUniqueOrThrow({ where: { id: old.id } }))
          .overdueNotifiedAt,
      ).not.toBeNull();
    });
  });

  describe('企业微信群机器人', () => {
    it('只有能改业务设置的人能管理；地址必须是企业微信官方机器人', async () => {
      await as('sales').get('/notify-channels').expect(403);
      await as('admin')
        .post('/notify-channels', {
          name: '假的',
          webhook: 'https://example.com/cgi-bin/webhook/send?key=abcdefgh',
          events: ['task.created'],
        })
        .expect(400);
      await as('admin')
        .post('/notify-channels', {
          name: '充值群',
          webhook: WEBHOOK,
          events: ['task.created', 'daily.digest'],
        })
        .expect(201);
      await as('admin')
        .post('/notify-channels', {
          name: '老板群',
          webhook: WEBHOOK,
          events: ['refund.requested'],
        })
        .expect(201);
      const list = await as('admin').get('/notify-channels').expect(200);
      expect(list.body).toHaveLength(2);
      expect(list.body[0]).toMatchObject({
        name: '充值群',
        webhookHint: '0f1e****e1f0',
        enabled: true,
      });
      expect(JSON.stringify(list.body)).not.toContain('4b5a-6978');
      ids.group = list.body[0].id;
      ids.boss = list.body[1].id;
      const stored = await prisma.notifyChannel.findUniqueOrThrow({ where: { id: ids.group } });
      expect(stored.webhookEnc).not.toContain('qyapi');
    });

    it('业务事件只推到订阅了它的群，发送成功标记已发送', async () => {
      await prisma.outboundMessage.deleteMany();
      send.mockClear();
      await paidOrder();
      const queued = await prisma.outboundMessage.findMany();
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        channelId: ids.group,
        event: 'task.created',
        status: 'PENDING',
      });
      expect(queued[0].content).toContain('【新的开通 / 续费任务】');
      expect(await dispatcher.deliverDue()).toBe(1);
      expect(send).toHaveBeenCalledWith(WEBHOOK, queued[0].content);
      const sent = await prisma.outboundMessage.findUniqueOrThrow({ where: { id: queued[0].id } });
      expect(sent.status).toBe('SENT');
      const list = await as('admin').get('/notify-channels').expect(200);
      expect(list.body[0].lastSentAt).not.toBeNull();
    });

    it('发送失败按 1、5、30、120 分钟重试，5 次都失败标记失败，可以手动重发', async () => {
      await prisma.outboundMessage.deleteMany();
      send.mockRejectedValue(new Error('企业微信返回错误 93000：invalid webhook url'));
      await paidOrder();
      let now = new Date();
      for (let i = 1; i <= 5; i++) {
        expect(await dispatcher.deliverDue(now)).toBe(0);
        const m = await prisma.outboundMessage.findFirstOrThrow();
        expect(m.attempts).toBe(i);
        expect(m.status).toBe(i < 5 ? 'PENDING' : 'FAILED');
        now = addHours(now, 3);
      }
      const list = await as('admin').get('/notify-channels').expect(200);
      expect(list.body[0]).toMatchObject({ failed: 1, pending: 0 });
      expect(list.body[0].lastError).toContain('93000');
      const log = await as('admin').get(`/notify-channels/messages?status=FAILED`).expect(200);
      expect(log.body.items[0]).toMatchObject({ channelName: '充值群', attempts: 5 });

      send.mockResolvedValue(undefined);
      await as('admin').post(`/notify-channels/messages/${log.body.items[0].id}/retry`).expect(200);
      await as('admin').post(`/notify-channels/messages/${log.body.items[0].id}/retry`).expect(400);
      expect(await dispatcher.deliverDue()).toBe(1);
    });

    it('停用的群不再收新消息；测试消息直接发送并返回结果', async () => {
      await as('admin').patch(`/notify-channels/${ids.group}`, { enabled: false }).expect(200);
      await prisma.outboundMessage.deleteMany();
      await paidOrder();
      expect(await prisma.outboundMessage.count()).toBe(0);
      await as('admin').patch(`/notify-channels/${ids.group}`, { enabled: true }).expect(200);

      send.mockClear();
      const ok = await as('admin').post(`/notify-channels/${ids.boss}/test`).expect(200);
      expect(ok.body).toEqual({ ok: true, error: null });
      expect(send.mock.calls[0][1]).toContain('老板群');
      send.mockRejectedValueOnce(new Error('连接企业微信失败：timeout'));
      const bad = await as('admin').post(`/notify-channels/${ids.boss}/test`).expect(200);
      expect(bad.body).toEqual({ ok: false, error: '连接企业微信失败：timeout' });
    });

    it('每日早报：到了设置的钟点推一次，只推群、不发站内消息', async () => {
      await prisma.outboundMessage.deleteMany();
      await prisma.setting.deleteMany({ where: { key: 'notifyDigestDate' } });
      const today = localDateKey(new Date());
      const eight = addHours(parseLocalDate(today)!, 8);
      const nine = addHours(parseLocalDate(today)!, 9);
      expect((await scan.run(eight)).digestSent).toBe(false);
      const before = await prisma.notification.count();
      expect((await scan.run(nine)).digestSent).toBe(true);
      expect((await scan.run(addHours(nine, 1))).digestSent).toBe(false);
      const digest = await prisma.outboundMessage.findMany({ where: { event: 'daily.digest' } });
      expect(digest).toHaveLength(1);
      expect(digest[0].channelId).toBe(ids.group);
      expect(digest[0].content).toContain('昨天收款');
      expect(digest[0].content).toContain('待开通 / 续费任务');
      expect(await prisma.notification.count()).toBe(before);
      // 改了早报时间，第二天按新时间
      await as('admin').patch('/settings', { dailyDigestHour: 10 }).expect(200);
      const tomorrowNine = addDays(nine, 1);
      expect((await scan.run(tomorrowNine)).digestSent).toBe(false);
      expect((await scan.run(addHours(tomorrowNine, 1))).digestSent).toBe(true);
    });

    it('删除群机器人连同没发出去的消息', async () => {
      await paidOrder();
      await as('admin').delete(`/notify-channels/${ids.group}`).expect(200);
      expect(await prisma.outboundMessage.count({ where: { channelId: ids.group } })).toBe(0);
      const audit = await prisma.auditLog.findMany({
        where: { action: { startsWith: 'notify.channel' } },
        select: { action: true },
      });
      expect(audit.map((a) => a.action)).toEqual(
        expect.arrayContaining([
          'notify.channel.create',
          'notify.channel.update',
          'notify.channel.delete',
        ]),
      );
    });
  });
});
