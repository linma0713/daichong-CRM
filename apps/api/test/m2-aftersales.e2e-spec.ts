import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { addDays, addHours } from '../src/common/dates';
import { SweepService } from '../src/scheduler/sweep';
import { runSeed } from '../prisma/seed';

const PASSWORD = 'Crm2026test';
type Who = 'admin' | 'sales' | 'fulfiller' | 'aftersales' | 'finance';

/**
 * M2 第二批：质保加购 → 售后工单（处理时限、超时升级、自动关闭）→ 换号 / 补偿 / 退款审批
 */
describe('M2 售后与质保', () => {
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

  /** 客服下单收齐款；可选由充值员完成开通 */
  async function paidOrder(body: object, complete?: object) {
    const order = await as('sales').post('/orders', body).expect(201);
    const paid = await as('sales')
      .post(`/orders/${order.body.id}/payments`, {
        amountCents: order.body.amountCents,
        method: 'wechat',
      })
      .expect(200);
    const taskId = paid.body.tasks[0]?.id as string;
    let subscriptionId: string | null = null;
    if (complete) {
      await as('fulfiller').post(`/tasks/${taskId}/complete`, complete).expect(200);
      const o = await as('admin').get(`/orders/${order.body.id}`).expect(200);
      subscriptionId = o.body.subscription.id;
    }
    return { orderId: order.body.id as string, taskId, subscriptionId: subscriptionId! };
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
    for (const [key, planId, termMonths, fulfillmentType, priceCents] of [
      ['maxMonthly', ids.max, 1, 'RECHARGE', 100000],
      ['proAccount', ids.pro, 1, 'ACCOUNT', 30000],
    ] as const) {
      const p = await as('admin')
        .post('/products', { planId, termMonths, fulfillmentType, priceCents })
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
        accounts: [
          { email: 'pro-a@example.com', password: 'pa' },
          { email: 'pro-b@example.com', password: 'pb' },
        ],
      })
      .expect(201);
    for (const [key, name] of [
      ['zhang', '张先生'],
      ['wang', '王总'],
    ] as const) {
      const c = await as('sales')
        .post('/customers', { name, wechat: `as_${key}` })
        .expect(201);
      ids[key] = c.body.id;
    }
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  describe('质保加购', () => {
    it('商品设置质保价；没设置的商品不能加购', async () => {
      await as('sales')
        .patch(`/products/${ids.proAccount}`, { warrantyPriceCents: 5000 })
        .expect(403);
      const res = await as('admin')
        .patch(`/products/${ids.proAccount}`, { warrantyPriceCents: 5000 })
        .expect(200);
      expect(res.body.warrantyPriceCents).toBe(5000);
      await as('sales')
        .post('/orders', {
          customerId: ids.zhang,
          kind: 'NEW',
          productId: ids.maxMonthly,
          withWarranty: true,
          accountEmail: 'zhang@example.com',
        })
        .expect(400);
      await as('admin')
        .patch(`/products/${ids.maxMonthly}`, { warrantyPriceCents: 8000 })
        .expect(200);
    });

    it('加购质保：应收 = 售价 − 优惠 + 质保费', async () => {
      const order = await as('sales')
        .post('/orders', {
          customerId: ids.wang,
          kind: 'NEW',
          productId: ids.proAccount,
          withWarranty: true,
          discountCents: 1000,
        })
        .expect(201);
      expect(order.body).toMatchObject({
        withWarranty: true,
        warrantyCents: 5000,
        amountCents: 34000,
        refundedCents: 0,
      });
      await as('sales')
        .post(`/orders/${order.body.id}/payments`, { amountCents: 34000, method: 'wechat' })
        .expect(200);
      const tasks = await as('fulfiller').get('/tasks').expect(200);
      const task = tasks.body.items.find(
        (t: { order: { id: string } | null }) => t.order?.id === order.body.id,
      );
      const stock = await as('fulfiller').get(`/stock-accounts?planId=${ids.pro}&status=IN_STOCK`);
      ids.stockA = stock.body.items[0].id;
      ids.stockB = stock.body.items[1].id;
      await as('fulfiller')
        .post(`/tasks/${task.id}/complete`, { stockAccountId: ids.stockA })
        .expect(200);
      const done = await as('admin').get(`/orders/${order.body.id}`).expect(200);
      ids.wangOrder = done.body.id;
      ids.wangSub = done.body.subscription.id;
      expect(done.body.profit.costCents).toBe(1500);
    });

    it('订阅详情显示质保情况', async () => {
      const sub = await as('admin').get(`/subscriptions/${ids.wangSub}`).expect(200);
      expect(sub.body.warranty).toMatchObject({
        covered: true,
        canReplace: true,
        withWarranty: true,
        planPaidCents: 29000,
      });
      expect(sub.body.warranty.refundableCents).toBeGreaterThan(27000);
      expect(sub.body.warranty.summary).toMatch(/^可包换 · 可退 ¥/);
    });
  });

  describe('售后工单', () => {
    it('客服登记封号工单：自动派给售后，按类型定处理时限', async () => {
      await as('fulfiller')
        .post('/tickets', { customerId: ids.wang, type: 'BANNED', description: 'x' })
        .expect(403);
      const res = await as('sales')
        .post('/tickets', {
          customerId: ids.wang,
          subscriptionId: ids.wangSub,
          type: 'BANNED',
          description: '客户说登录提示账号被停用',
        })
        .expect(201);
      expect(res.body.code).toBe('G00001');
      expect(res.body.status).toBe('OPEN');
      expect(res.body.assignee.id).toBe(ids.aftersales);
      expect(res.body.order.id).toBe(ids.wangOrder);
      const sla = new Date(res.body.dueAt).getTime() - new Date(res.body.createdAt).getTime();
      expect(Math.round(sla / 3600_000)).toBe(4);
      expect(res.body.warranty.covered).toBe(true);
      expect(res.body.events[0].kind).toBe('created');
      ids.bannedTicket = res.body.id;
    });

    it('客服只能看、不能处理；售后可以', async () => {
      await as('sales').get(`/tickets/${ids.bannedTicket}`).expect(200);
      await as('sales')
        .patch(`/tickets/${ids.bannedTicket}`, { status: 'IN_PROGRESS' })
        .expect(403);
      await as('sales').post(`/tickets/${ids.bannedTicket}/replace`, {}).expect(403);
      await as('aftersales')
        .post(`/tickets/${ids.bannedTicket}/comments`, { content: '已让客户截图' })
        .expect(200);
      const mine = await as('aftersales').get('/tickets?assignee=me').expect(200);
      expect(mine.body.total).toBe(1);
    });

    it('客户原因（自行改密码）不在质保内；取消后恢复', async () => {
      const res = await as('aftersales')
        .patch(`/tickets/${ids.bannedTicket}`, { customerFault: 'CHANGED_PASSWORD' })
        .expect(200);
      expect(res.body.warranty).toMatchObject({
        covered: false,
        reason: '客户自行改密码',
        refundableCents: 0,
      });
      const back = await as('aftersales')
        .patch(`/tickets/${ids.bannedTicket}`, { customerFault: null })
        .expect(200);
      expect(back.body.warranty.covered).toBe(true);
      expect(back.body.events.map((e: { kind: string }) => e.kind)).toEqual([
        'created',
        'comment',
        'fault',
        'fault',
      ]);
    });

    it('换号：派任务给充值员，完成后订阅换号、服务期不变、旧号作废、成本记到订单、工单自动解决', async () => {
      const before = await prisma.subscription.findUniqueOrThrow({ where: { id: ids.wangSub } });
      const res = await as('aftersales')
        .post(`/tickets/${ids.bannedTicket}/replace`, { note: '封号换号' })
        .expect(200);
      expect(res.body.status).toBe('IN_PROGRESS');
      expect(res.body.tasks).toHaveLength(1);
      await as('aftersales').post(`/tickets/${ids.bannedTicket}/replace`, {}).expect(400);

      const taskId = res.body.tasks[0].id;
      const task = await as('fulfiller').get(`/tasks/${taskId}`).expect(200);
      expect(task.body).toMatchObject({
        type: 'REPLACE_ACCOUNT',
        chargeMode: 'optional',
        planId: ids.pro,
        ticket: { code: 'G00001' },
      });
      expect(task.body.assignee.id).toBe(ids.fulfiller);
      await as('fulfiller')
        .post(`/tasks/${taskId}/complete`, { stockAccountId: ids.stockA })
        .expect(400);
      await as('fulfiller')
        .post(`/tasks/${taskId}/complete`, { stockAccountId: ids.stockB })
        .expect(200);

      const after = await prisma.subscription.findUniqueOrThrow({ where: { id: ids.wangSub } });
      expect(after.accountId).toBe(ids.stockB);
      expect(after.endAt.getTime()).toBe(before.endAt.getTime());
      const old = await prisma.claudeAccount.findUniqueOrThrow({ where: { id: ids.stockA } });
      expect(old).toMatchObject({ stockStatus: 'VOID', customerId: null });
      const order = await as('admin').get(`/orders/${ids.wangOrder}`).expect(200);
      expect(order.body.profit.costCents).toBe(3000);

      const ticket = await as('aftersales').get(`/tickets/${ids.bannedTicket}`).expect(200);
      expect(ticket.body.status).toBe('RESOLVED');
      expect(ticket.body.resolution).toBe('已换号');
      expect(ticket.body.events.map((e: { kind: string }) => e.kind).slice(-3)).toEqual([
        'replace',
        'replace',
        'resolved',
      ]);
    });

    it('已解决超过 48 小时自动关闭', async () => {
      await sweep.run(addHours(new Date(), 47));
      expect(
        (await prisma.ticket.findUniqueOrThrow({ where: { id: ids.bannedTicket } })).status,
      ).toBe('RESOLVED');
      const r = await sweep.run(addHours(new Date(), 49));
      expect(r.closedTickets).toBe(1);
      const t = await as('aftersales').get(`/tickets/${ids.bannedTicket}`).expect(200);
      expect(t.body.status).toBe('CLOSED');
      expect(t.body.events.at(-1).content).toContain('自动关闭');
    });

    it('超过处理时限升级；等客户回复的不算超时', async () => {
      const a = await as('sales')
        .post('/tickets', {
          customerId: ids.wang,
          subscriptionId: ids.wangSub,
          type: 'NOT_EFFECTIVE',
          description: '客户说还是免费版',
        })
        .expect(201);
      const b = await as('sales')
        .post('/tickets', { customerId: ids.wang, type: 'OTHER', description: '问发票' })
        .expect(201);
      await as('aftersales')
        .patch(`/tickets/${b.body.id}`, { status: 'WAITING_CUSTOMER' })
        .expect(200);
      const r = await sweep.run(addHours(new Date(), 30));
      expect(r.escalatedTickets).toBe(1);
      const escalated = await as('aftersales').get(`/tickets/${a.body.id}`).expect(200);
      expect(escalated.body.escalatedAt).not.toBeNull();
      expect(escalated.body.events.at(-1).kind).toBe('escalated');
      const waiting = await as('aftersales').get(`/tickets/${b.body.id}`).expect(200);
      expect(waiting.body.escalatedAt).toBeNull();
      // 重复跑不会重复升级
      expect((await sweep.run(addHours(new Date(), 31))).escalatedTickets).toBe(0);

      const dash = await as('aftersales').get('/dashboard').expect(200);
      expect(dash.body.aftersales).toMatchObject({ open: 2, mine: 2 });
      ids.notEffectiveTicket = a.body.id;
      ids.otherTicket = b.body.id;
    });

    it('补偿天数：服务期往后延', async () => {
      const before = await prisma.subscription.findUniqueOrThrow({ where: { id: ids.wangSub } });
      const res = await as('aftersales')
        .post(`/tickets/${ids.notEffectiveTicket}/compensate`, { days: 3, note: '耽误了半天' })
        .expect(200);
      const after = await prisma.subscription.findUniqueOrThrow({ where: { id: ids.wangSub } });
      expect(after.endAt.getTime()).toBe(addDays(before.endAt, 3).getTime());
      expect(res.body.events.at(-1).content).toContain('补偿 3 天');
      await as('aftersales')
        .post(`/tickets/${ids.notEffectiveTicket}/resolve`, { resolution: '已补偿' })
        .expect(200);
      const reopened = await as('sales')
        .post(`/tickets/${ids.notEffectiveTicket}/reopen`, { reason: '客户说还是不行' })
        .expect(200);
      expect(reopened.body.status).toBe('IN_PROGRESS');
      expect(reopened.body.escalatedAt).toBeNull();
      await as('aftersales').post(`/tickets/${ids.notEffectiveTicket}/close`, {}).expect(200);
      await as('aftersales')
        .post(`/tickets/${ids.otherTicket}/close`, { note: '已回复' })
        .expect(200);
    });
  });

  describe('退款', () => {
    it('代充 + 质保：按天退款并终止服务，财务审批出账', async () => {
      const { orderId, subscriptionId } = await paidOrder(
        {
          customerId: ids.zhang,
          kind: 'NEW',
          productId: ids.maxMonthly,
          withWarranty: true,
          accountEmail: 'zhang@example.com',
        },
        { resourceId: ids.card },
      );
      ids.zhangOrder = orderId;
      ids.zhangSub = subscriptionId;
      const ticket = await as('sales')
        .post('/tickets', {
          customerId: ids.zhang,
          subscriptionId,
          type: 'REFUND',
          description: '客户不想用了，要求退款',
        })
        .expect(201);
      ids.refundTicket = ticket.body.id;
      const w = ticket.body.warranty;
      expect(w.covered).toBe(true);
      expect(w.planPaidCents).toBe(100000);
      expect(w.refundableCents).toBe(Math.round((100000 * w.remainingDays) / w.totalDays));
      expect(ticket.body.refundableCents).toBe(108000);

      await as('sales').post('/refunds', { orderId, amountCents: 1000, reason: 'x' }).expect(403);
      await as('aftersales')
        .post('/refunds', { orderId, ticketId: ticket.body.id, amountCents: 108001, reason: 'x' })
        .expect(400);
      const refund = await as('aftersales')
        .post('/refunds', {
          orderId,
          ticketId: ticket.body.id,
          amountCents: w.refundableCents,
          reason: '按质保剩余天数退款',
          terminate: true,
        })
        .expect(201);
      expect(refund.body).toMatchObject({ code: 'K00001', status: 'PENDING', terminate: true });
      ids.refund1 = refund.body.id;
      ids.refund1Amount = String(w.refundableCents);
      const detail = await as('admin').get(`/orders/${orderId}`).expect(200);
      expect(detail.body.refundableCents).toBe(108000 - w.refundableCents);
    });

    it('只有有审批权限的人能通过；通过后订单记退款、毛利扣减、订阅终止、派取消自动续订任务', async () => {
      await as('aftersales')
        .post(`/refunds/${ids.refund1}/approve`, { method: 'wechat' })
        .expect(403);
      const before = await as('admin').get(`/orders/${ids.zhangOrder}`).expect(200);
      const dash = await as('finance').get('/dashboard').expect(200);
      expect(dash.body.aftersales.pendingRefunds).toBe(1);

      const res = await as('finance')
        .post(`/refunds/${ids.refund1}/approve`, { method: 'wechat', reference: 'WX123' })
        .expect(200);
      expect(res.body.status).toBe('PAID');
      expect(res.body.approvedBy.id).toBe(ids.finance);
      await as('finance').post(`/refunds/${ids.refund1}/approve`, { method: 'wechat' }).expect(400);

      const amount = Number(ids.refund1Amount);
      const order = await as('admin').get(`/orders/${ids.zhangOrder}`).expect(200);
      expect(order.body.refundedCents).toBe(amount);
      expect(order.body.marginCents).toBe(before.body.marginCents - amount);
      expect(order.body.profit.estRemainingCostCents).toBe(0);

      const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: ids.zhangSub } });
      expect(sub.status).toBe('CANCELLED');
      expect(sub.endAt.getTime()).toBeLessThanOrEqual(Date.now());
      const tasks = await prisma.fulfillmentTask.findMany({
        where: { subscriptionId: ids.zhangSub, type: 'CANCEL_AUTO_RENEW' },
      });
      expect(tasks).toHaveLength(1);

      const ticket = await as('aftersales').get(`/tickets/${ids.refundTicket}`).expect(200);
      expect(ticket.body.status).toBe('RESOLVED');
      expect(ticket.body.refunds[0].status).toBe('PAID');
      expect(ticket.body.warranty).toMatchObject({
        covered: false,
        canReplace: false,
        reason: '已退款并终止服务',
      });
    });

    it('驳回退款', async () => {
      const r = await as('aftersales')
        .post('/refunds', { orderId: ids.wangOrder, amountCents: 2000, reason: '客户嫌慢' })
        .expect(201);
      const res = await as('finance')
        .post(`/refunds/${r.body.id}/reject`, { reason: '没有质量问题' })
        .expect(200);
      expect(res.body).toMatchObject({ status: 'REJECTED', rejectReason: '没有质量问题' });
      const order = await prisma.order.findUniqueOrThrow({ where: { id: ids.wangOrder } });
      expect(order.refundedCents).toBe(0);
      const list = await as('finance').get('/refunds?status=REJECTED').expect(200);
      expect(list.body.total).toBe(1);
    });

    it('还没开通的订单全额退款：取消开通任务，订单标记已取消', async () => {
      const { orderId, taskId } = await paidOrder({
        customerId: ids.zhang,
        kind: 'NEW',
        productId: ids.proAccount,
      });
      const r = await as('aftersales')
        .post('/refunds', { orderId, amountCents: 30000, reason: '客户付错了', terminate: true })
        .expect(201);
      await as('finance').post(`/refunds/${r.body.id}/approve`, { method: 'alipay' }).expect(200);
      const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(order).toMatchObject({ status: 'CANCELLED', refundedCents: 30000 });
      const task = await prisma.fulfillmentTask.findUniqueOrThrow({ where: { id: taskId } });
      expect(task.status).toBe('CANCELLED');
    });
  });

  describe('代充换号', () => {
    it('要填客户新账号，并登记这次上游扣费', async () => {
      const { subscriptionId } = await paidOrder(
        {
          customerId: ids.wang,
          kind: 'NEW',
          productId: ids.maxMonthly,
          accountEmail: 'wang-old@example.com',
        },
        { resourceId: ids.card },
      );
      const ticket = await as('aftersales')
        .post('/tickets', {
          customerId: ids.wang,
          subscriptionId,
          type: 'LIMITED',
          description: '一直限额',
        })
        .expect(201);
      expect(ticket.body.warranty).toMatchObject({
        covered: false,
        reason: '这笔订单没有购买质保',
      });
      const res = await as('aftersales').post(`/tickets/${ticket.body.id}/replace`, {}).expect(200);
      const taskId = res.body.tasks[0].id;
      const task = await as('fulfiller').get(`/tasks/${taskId}`).expect(200);
      expect(task.body.chargeMode).toBe('required');
      await as('fulfiller').post(`/tasks/${taskId}/complete`, { resourceId: ids.card }).expect(400);
      const noCharge = await as('fulfiller')
        .post(`/tasks/${taskId}/complete`, { accountEmail: 'wang-new@example.com' })
        .expect(400);
      expect(noCharge.body.code).toBe('CHARGE_REQUIRED');
      await as('fulfiller')
        .post(`/tasks/${taskId}/complete`, {
          accountEmail: 'Wang-New@example.com',
          accountPassword: 'new-pass',
          resourceId: ids.card,
        })
        .expect(200);
      const sub = await prisma.subscription.findUniqueOrThrow({
        where: { id: subscriptionId },
        include: { account: true },
      });
      expect(sub.account).toMatchObject({
        email: 'wang-new@example.com',
        ownership: 'CUSTOMER',
        customerId: ids.wang,
      });
      const costs = await prisma.costEntry.count({ where: { subscriptionId } });
      expect(costs).toBe(2);
    });
  });

  it('操作都记了日志', async () => {
    const actions = (await prisma.auditLog.findMany({ select: { action: true } })).map(
      (l) => l.action,
    );
    for (const a of [
      'ticket.create',
      'ticket.update',
      'ticket.replace',
      'ticket.compensate',
      'refund.request',
      'refund.approve',
      'refund.reject',
    ]) {
      expect(actions).toContain(a);
    }
  });
});
