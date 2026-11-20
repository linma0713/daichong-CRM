/**
 * 初始化数据：内置角色 + 默认套餐 + 首个管理员。可以重复执行，不会覆盖已有数据。
 * 用法：pnpm db:seed（docker compose 启动时会自动执行）
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { ALL_PERMISSIONS, BUILT_IN_ROLES } from '@crm/shared';

export interface SeedOptions {
  adminUsername: string;
  adminPassword: string;
  log?: (msg: string) => void;
}

export async function runSeed(prisma: PrismaClient, opts: SeedOptions): Promise<void> {
  const log = opts.log ?? (() => undefined);

  for (const role of BUILT_IN_ROLES) {
    const existing = await prisma.role.findUnique({ where: { code: role.code } });
    if (!existing) {
      await prisma.role.create({
        data: {
          code: role.code,
          name: role.name,
          description: role.description,
          permissions: role.permissions,
          dataScope: role.dataScope,
          builtIn: true,
        },
      });
      log(`已创建内置角色：${role.name}`);
    } else if (role.code === 'admin') {
      // 管理员角色始终保持全部权限，避免被误改后没人能管理系统
      await prisma.role.update({
        where: { id: existing.id },
        data: { permissions: [ALL_PERMISSIONS], dataScope: 'ALL', builtIn: true },
      });
    }
  }

  // 默认套餐：官方月费只是初始值，请在「商品与套餐」里按官方实际价格修改；售价不预设
  if ((await prisma.plan.count()) === 0) {
    await prisma.plan.createMany({
      data: [
        { code: 'PRO', name: 'Pro', upstreamMonthlyUsdCents: 2000, sort: 10 },
        { code: 'MAX', name: 'Max', upstreamMonthlyUsdCents: 10000, sort: 20 },
        { code: 'ULTRA', name: 'Ultra', upstreamMonthlyUsdCents: 20000, sort: 30 },
      ],
    });
    log('已创建默认套餐：Pro / Max / Ultra（官方月费请按实际价格修改）');
  }

  const userCount = await prisma.user.count();
  if (userCount === 0) {
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'admin' } });
    await prisma.user.create({
      data: {
        username: opts.adminUsername,
        displayName: '管理员',
        passwordHash: await bcrypt.hash(opts.adminPassword, 10),
        mustChangePassword: true,
        roles: { create: [{ roleId: adminRole.id }] },
      },
    });
    log(`已创建管理员账号：${opts.adminUsername}（首次登录需修改密码）`);
  }
}

async function main() {
  const prisma = new PrismaClient();
  try {
    await runSeed(prisma, {
      adminUsername: process.env.SEED_ADMIN_USERNAME || 'admin',
      adminPassword: process.env.SEED_ADMIN_PASSWORD || 'Admin@123456',
      log: (m) => console.log(`[seed] ${m}`),
    });
    console.log('[seed] 完成');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
