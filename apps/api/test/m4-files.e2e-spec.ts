import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { runSeed } from '../prisma/seed';

const PASSWORD = 'Crm2026test';
type Who = 'admin' | 'sales' | 'sales2' | 'zhang' | 'aftersales' | 'finance';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake png body for tests'),
]);
const PDF = Buffer.from('%PDF-1.4\n%fake pdf\n');

/**
 * M4 第四批：附件（截图、凭证）、批量导入客户、导出客户和订单
 */
describe('M4 附件与导入导出', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const http = () => request(app.getHttpServer());
  const tokens = {} as Record<Who, string>;
  const ids: Record<string, string> = {};
  const as = (who: Who) => ({
    get: (url: string) => http().get(`/api${url}`).auth(tokens[who], { type: 'bearer' }),
    post: (url: string, body: object = {}) =>
      http().post(`/api${url}`).auth(tokens[who], { type: 'bearer' }).send(body),
    delete: (url: string) => http().delete(`/api${url}`).auth(tokens[who], { type: 'bearer' }),
    upload: (ownerType: string, ownerId: string, data: Buffer, filename = 'shot.png') =>
      http()
        .post('/api/attachments')
        .auth(tokens[who], { type: 'bearer' })
        .field('ownerType', ownerType)
        .field('ownerId', ownerId)
        .attach('file', data, { filename }),
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

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$executeRawUnsafe(`
      TRUNCATE TABLE "AuditLog", "Session", "UserRole", "User", "Role", "Team", "Customer",
        "FollowUp", "Plan", "Product", "Order", "Payment", "ClaudeAccount", "Subscription",
        "FulfillmentTask", "Setting", "PaymentResource", "ResourceTransaction", "CostEntry",
        "Ticket", "TicketEvent", "Refund", "Agent", "Commission", "CommissionStatement",
        "Notification", "NotifyChannel", "OutboundMessage", "ScriptTemplate", "Channel",
        "ChannelCost", "ReferralReward", "Attachment"
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
    const p = await http()
      .post('/api/products')
      .auth(tokens.admin, { type: 'bearer' })
      .send({
        planId: plans.body[0].id,
        termMonths: 1,
        fulfillmentType: 'RECHARGE',
        priceCents: 100000,
      })
      .expect(201);
    const c = await as('sales')
      .post('/customers', { name: '附件客户', wechat: 'm4f_1' })
      .expect(201);
    ids.customer = c.body.id;
    const o = await as('sales')
      .post('/orders', {
        customerId: c.body.id,
        kind: 'NEW',
        productId: p.body.id,
        accountEmail: 'm4f_1@example.com',
      })
      .expect(201);
    ids.order = o.body.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('附件', () => {
    it('客服给自己的订单传收款截图；列表、下载都按内容识别类型，中文文件名保留', async () => {
      const res = await as('sales').upload('order', ids.order, PNG, '收款截图.png').expect(201);
      expect(res.body).toMatchObject({
        ownerType: 'order',
        ownerId: ids.order,
        fileName: '收款截图.png',
        mimeType: 'image/png',
        size: PNG.length,
        uploadedBy: { id: ids.sales },
        canDelete: true,
      });
      ids.att1 = res.body.id;
      const list = await as('sales').get(`/attachments?ownerType=order&ownerId=${ids.order}`);
      expect(list.status).toBe(200);
      expect(list.body.map((a: { id: string }) => a.id)).toEqual([ids.att1]);

      const file = await as('sales')
        .get(`/attachments/${ids.att1}/file`)
        .buffer(true)
        .parse((r, cb) => {
          const chunks: Buffer[] = [];
          r.on('data', (c: Buffer) => chunks.push(c));
          r.on('end', () => cb(null, Buffer.concat(chunks)));
        })
        .expect(200);
      expect(file.headers['content-type']).toBe('image/png');
      expect(file.headers['x-content-type-options']).toBe('nosniff');
      expect(file.headers['content-disposition']).toContain(encodeURIComponent('收款截图.png'));
      expect(Buffer.compare(file.body as Buffer, PNG)).toBe(0);

      // 扩展名写 .png 但内容是 PDF：按内容存成 PDF
      const pdf = await as('sales').upload('order', ids.order, PDF, '转账.png').expect(201);
      expect(pdf.body.mimeType).toBe('application/pdf');
      const pdfFile = await as('sales').get(`/attachments/${pdf.body.id}/file`).expect(200);
      expect(pdfFile.headers['content-disposition']).toMatch(/^attachment;/);
    });

    it('只收图片和 PDF；空文件、SVG、网页、超过 10 MB 都不收', async () => {
      await as('sales').upload('order', ids.order, Buffer.from('<svg></svg>'), 'a.svg').expect(400);
      await as('sales')
        .upload(
          'order',
          ids.order,
          Buffer.from('<!doctype html><script>alert(1)</script>'),
          'a.html',
        )
        .expect(400);
      await as('sales')
        .post('/attachments', { ownerType: 'order', ownerId: ids.order })
        .expect(400);
      const big = Buffer.alloc(10 * 1024 * 1024 + 10, 0);
      PNG.copy(big);
      const res = await as('sales').upload('order', ids.order, big, 'big.png');
      expect([400, 413]).toContain(res.status);
      await as('sales').upload('nope', ids.order, PNG).expect(400);
    });

    it('附件跟着业务的权限和数据范围走：看不到订单就看不到、传不了附件', async () => {
      // 另一个客服（只看自己的）
      await as('sales2').get(`/attachments?ownerType=order&ownerId=${ids.order}`).expect(404);
      await as('sales2').upload('order', ids.order, PNG).expect(404);
      await as('sales2').get(`/attachments/${ids.att1}/file`).expect(404);
      // 充值员没有查看订单的权限
      await as('zhang').get(`/attachments?ownerType=order&ownerId=${ids.order}`).expect(404);
      // 售后能看订单，但不能给订单传附件
      await as('aftersales').get(`/attachments?ownerType=order&ownerId=${ids.order}`).expect(200);
      await as('aftersales').upload('order', ids.order, PNG).expect(403);
      // 不存在的订单
      await as('admin').upload('order', 'nope', PNG).expect(404);
      // 客户附件：客服可以传自己客户的
      await as('sales').upload('customer', ids.customer, PNG, '聊天记录.png').expect(201);
      await as('sales2').upload('customer', ids.customer, PNG).expect(404);
    });

    it('删除：上传的人或管理员可以删，删了文件也一起删掉', async () => {
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: ids.att1 } });
      const path = join(process.env.UPLOAD_DIR!, row.storageKey);
      expect(existsSync(path)).toBe(true);
      const other = await as('admin').upload('order', ids.order, PNG, 'admin.png').expect(201);
      const list = await as('sales').get(`/attachments?ownerType=order&ownerId=${ids.order}`);
      expect(list.body.find((a: { id: string }) => a.id === other.body.id).canDelete).toBe(false);
      await as('sales').delete(`/attachments/${other.body.id}`).expect(403);
      await as('aftersales').delete(`/attachments/${ids.att1}`).expect(403);
      await as('sales').delete(`/attachments/${ids.att1}`).expect(200);
      expect(existsSync(path)).toBe(false);
      await as('sales').get(`/attachments/${ids.att1}/file`).expect(404);
      await as('admin').delete(`/attachments/${other.body.id}`).expect(200);
      const logs = await prisma.auditLog.findMany({
        where: { action: { in: ['attachment.upload', 'attachment.delete'] } },
      });
      expect(logs.filter((l) => l.action === 'attachment.delete')).toHaveLength(2);
      expect(logs.length).toBeGreaterThan(2);
    });

    it('每条业务最多 30 个附件；文件丢了下载给出明确提示', async () => {
      const existing = await prisma.attachment.count({
        where: { ownerType: 'order', ownerId: ids.order },
      });
      await prisma.attachment.createMany({
        data: Array.from({ length: 30 - existing }, (_, i) => ({
          ownerType: 'order',
          ownerId: ids.order,
          fileName: `x${i}.png`,
          mimeType: 'image/png',
          size: 1,
          storageKey: `missing/x${i}.png`,
          uploadedById: ids.sales,
        })),
      });
      const res = await as('sales').upload('order', ids.order, PNG).expect(400);
      expect(res.body.message).toContain('最多 30 个');
      const missing = await prisma.attachment.findFirstOrThrow({
        where: { storageKey: 'missing/x0.png' },
      });
      const r = await as('sales').get(`/attachments/${missing.id}/file`).expect(404);
      expect(r.body.message).toContain('uploads');
    });
  });

  describe('批量导入客户', () => {
    const rows = [
      {
        name: '导入一',
        wechat: 'imp_1',
        source: '投放',
        tags: '老客、大客户 抖音',
        remark: '备注一',
      },
      { name: '导入二', phone: '13800000002', source: 'referral', owner: '客服小赵' },
      { name: '', wechat: 'imp_3' },
      { name: '没联系方式' },
      { name: '重复微信', wechat: 'IMP_1' },
      { name: '已有客户', wechat: 'm4f_1' },
      { name: '来源不对', wechat: 'imp_7', source: '朋友圈' },
      { name: '渠道不存在', wechat: 'imp_8', channel: '小红书' },
      { name: '邮箱不对', email: 'not-an-email' },
      { name: '负责人不存在', wechat: 'imp_10', owner: '张三' },
    ];

    it('先检查：逐行告诉哪里不对，不写数据库', async () => {
      await as('aftersales').post('/customers/import', { rows, dryRun: true }).expect(403);
      const res = await as('admin').post('/customers/import', { rows, dryRun: true }).expect(200);
      expect(res.body).toMatchObject({ total: 10, valid: 2, created: 0 });
      const byRow = Object.fromEntries(
        res.body.rows.map((r: { row: number; errors: string[] }) => [r.row, r.errors.join('；')]),
      );
      expect(byRow[1]).toBe('');
      expect(byRow[2]).toBe('');
      expect(res.body.rows[1].ownerName).toBe('客服小赵');
      expect(byRow[3]).toContain('缺少称呼');
      expect(byRow[4]).toContain('至少填一个');
      expect(byRow[5]).toContain('和第 1 行重复');
      expect(byRow[6]).toContain('已经是客户 C00001 的了（负责人：客服小王）');
      expect(byRow[7]).toContain('来源只能填');
      expect(byRow[8]).toContain('渠道「小红书」不存在');
      expect(byRow[9]).toContain('邮箱格式不正确');
      expect(byRow[10]).toContain('负责人「张三」不存在');
      expect(await prisma.customer.count()).toBe(1);
    });

    it('客服只能导给自己；正式导入跳过有问题的行，并记操作日志', async () => {
      const check = await as('sales').post('/customers/import', { rows, dryRun: true }).expect(200);
      expect(check.body.rows[1].errors).toContain('你不能把客户分配给「客服小赵」');
      expect(check.body.rows[0].ownerName).toBe('客服小王');

      const res = await as('admin').post('/customers/import', { rows }).expect(200);
      expect(res.body).toMatchObject({ total: 10, valid: 2, created: 2 });
      const one = await prisma.customer.findFirstOrThrow({ where: { wechat: 'imp_1' } });
      expect(one).toMatchObject({
        name: '导入一',
        source: 'ads',
        tags: ['老客', '大客户', '抖音'],
        remark: '备注一',
        stage: 'LEAD',
      });
      const two = await prisma.customer.findFirstOrThrow({ where: { phone: '13800000002' } });
      expect(two).toMatchObject({ source: 'referral', ownerId: ids.sales2 });
      // 再导一次：全部已存在
      const again = await as('admin').post('/customers/import', { rows: rows.slice(0, 2) });
      expect(again.body).toMatchObject({ valid: 0, created: 0 });
      const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'customer.import' } });
      expect(log.detail).toMatchObject({ total: 10, created: 2, skipped: 8 });
      await as('admin').post('/customers/import', { rows: [] }).expect(400);
      await as('admin')
        .post('/customers/import', { rows: Array.from({ length: 501 }, () => ({ name: 'x' })) })
        .expect(400);
    });

    it('提示用表格行号；500 行带长备注也能一次提交', async () => {
      const res = await as('admin')
        .post('/customers/import', {
          rows: [
            { line: 3, name: '甲', wechat: 'line_a' },
            { line: 7, name: '乙', wechat: 'LINE_A' },
          ],
          dryRun: true,
        })
        .expect(200);
      expect(res.body.rows.map((r: { row: number }) => r.row)).toEqual([3, 7]);
      expect(res.body.rows[1].errors).toContain('微信和第 3 行重复');

      const big = Array.from({ length: 500 }, (_, i) => ({
        line: i + 2,
        name: `批量客户${i}`,
        wechat: `bulk_${i}`,
        remark: '很长的备注'.repeat(80),
      }));
      const bulk = await as('admin')
        .post('/customers/import', { rows: big, dryRun: true })
        .expect(200);
      expect(bulk.body).toMatchObject({ total: 500, valid: 500 });
    });
  });

  describe('导出', () => {
    it('导出客户要单独的权限，按列表筛选条件导出，并记日志', async () => {
      await as('sales').get('/exports/customers').expect(403);
      const res = await as('admin').get('/exports/customers?keyword=导入').expect(200);
      expect(res.body).toMatchObject({ total: 2, truncated: false });
      expect(res.body.items.map((c: { name: string }) => c.name).sort()).toEqual([
        '导入一',
        '导入二',
      ]);
      const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'customer.export' } });
      expect(log.detail).toMatchObject({ count: 2, filters: { keyword: '导入' } });
    });

    it('财务可以导出订单，客服不行', async () => {
      const me = await as('finance').get('/auth/me').expect(200);
      expect(me.body.permissions).toContain('order:export');
      await as('sales').get('/exports/orders').expect(403);
      const res = await as('finance').get('/exports/orders').expect(200);
      expect(res.body.items.map((o: { id: string }) => o.id)).toEqual([ids.order]);
      expect(await prisma.auditLog.count({ where: { action: 'order.export' } })).toBe(1);
    });
  });
});
