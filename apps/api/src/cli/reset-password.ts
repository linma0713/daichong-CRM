/**
 * 在服务器上重置员工密码：唯一的管理员忘了密码、或者手机丢了登不上两步验证时用。
 * 生成一个临时密码（第一次登录要求改掉），解除输错锁定，退出这个账号所有已登录的设备。
 *
 *   docker compose exec api node dist/src/cli/reset-password.js admin
 *   docker compose exec api node dist/src/cli/reset-password.js admin --clear-2fa   # 同时清掉两步验证
 *
 * 能登录服务器的人本来就能动所有数据，所以这里不再另外校验身份；每次使用都记一条操作日志。
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';

export async function resetPassword(
  prisma: PrismaClient,
  username: string,
  clear2fa: boolean,
): Promise<{ password: string; displayName: string; cleared2fa: boolean }> {
  const user = await prisma.user.findFirst({ where: { username, deletedAt: null } });
  if (!user) throw new Error(`没有这个员工账号：${username}`);
  // 去掉容易看错的 0 / O / 1 / l
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  const password = `Tmp-${Array.from(randomBytes(10), (b) => alphabet[b % alphabet.length]).join('')}`;
  const cleared2fa = clear2fa && !!user.totpSecret;
  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await bcrypt.hash(password, 10),
        mustChangePassword: true,
        failedLogins: 0,
        lockedUntil: null,
        ...(clear2fa
          ? { totpSecret: null, totpEnabledAt: null, totpLastStep: null, totpRecoveryHashes: [] }
          : {}),
      },
    }),
    prisma.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.auditLog.create({
      data: {
        action: 'user.reset_password_cli',
        summary: '在服务器上重置密码',
        resourceId: user.id,
        detail: { username, clear2fa: cleared2fa },
      },
    }),
  ]);
  return { password, displayName: user.displayName, cleared2fa };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const username = args.find((a) => !a.startsWith('--'));
  if (!username) {
    console.error('用法：node dist/src/cli/reset-password.js <用户名> [--clear-2fa]');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const r = await resetPassword(prisma, username, args.includes('--clear-2fa'));
    console.log(`已重置 ${r.displayName}（${username}）的密码。`);
    console.log(`临时密码：${r.password}`);
    console.log('第一次登录会要求改密码；这个账号之前登录的设备都已退出。');
    if (r.cleared2fa) console.log('两步验证已清除。如果角色要求两步验证，登录后会提示重新设置。');
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) void main();
