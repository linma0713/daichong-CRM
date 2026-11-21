/**
 * 更换 ACCOUNT_SECRET_KEY：用旧密钥解开所有加密字段，再用新密钥重新加密。
 *
 * 什么时候用：本地用示例密钥（全是 0）录过真实数据，上云时要换成随机密钥；或者怀疑密钥泄露。
 * 用法（先备份数据库！）：
 *   1. 把 .env 里的 ACCOUNT_SECRET_KEY 改成新密钥，另加一行 OLD_ACCOUNT_SECRET_KEY=旧密钥
 *   2. 先检查：docker compose run --rm api node dist/src/cli/rotate-secret-key.js
 *   3. 没问题再执行：docker compose run --rm api node dist/src/cli/rotate-secret-key.js --apply
 *   4. 删掉 .env 里的 OLD_ACCOUNT_SECRET_KEY，docker compose up -d 重启
 * 本地开发：pnpm --filter @crm/api secret:rotate [-- --apply]
 */
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { SecretBox } from '../common/secret-box';

type Db = PrismaClient | Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

interface Target {
  label: string;
  load(db: Db): Promise<{ id: string; value: string | null }[]>;
  save(db: Db, id: string, value: string): Promise<unknown>;
}

/** 所有用 ACCOUNT_SECRET_KEY 加密的字段。新增加密字段时要加到这里 */
export const SECRET_TARGETS: Target[] = [
  {
    label: 'Claude 账号密码',
    load: async (db) =>
      (
        await db.claudeAccount.findMany({
          where: { passwordEnc: { not: null } },
          select: { id: true, passwordEnc: true },
        })
      ).map((r) => ({ id: r.id, value: r.passwordEnc })),
    save: (db, id, value) =>
      db.claudeAccount.update({ where: { id }, data: { passwordEnc: value } }),
  },
  {
    label: 'Claude 账号其他敏感信息',
    load: async (db) =>
      (
        await db.claudeAccount.findMany({
          where: { secretNoteEnc: { not: null } },
          select: { id: true, secretNoteEnc: true },
        })
      ).map((r) => ({ id: r.id, value: r.secretNoteEnc })),
    save: (db, id, value) =>
      db.claudeAccount.update({ where: { id }, data: { secretNoteEnc: value } }),
  },
  {
    label: '付款资源敏感信息（卡号等）',
    load: async (db) =>
      (
        await db.paymentResource.findMany({
          where: { secretNoteEnc: { not: null } },
          select: { id: true, secretNoteEnc: true },
        })
      ).map((r) => ({ id: r.id, value: r.secretNoteEnc })),
    save: (db, id, value) =>
      db.paymentResource.update({ where: { id }, data: { secretNoteEnc: value } }),
  },
  {
    label: '企业微信群机器人地址',
    load: async (db) =>
      (await db.notifyChannel.findMany({ select: { id: true, webhookEnc: true } })).map((r) => ({
        id: r.id,
        value: r.webhookEnc,
      })),
    save: (db, id, value) =>
      db.notifyChannel.update({ where: { id }, data: { webhookEnc: value } }),
  },
  {
    label: '员工两步验证密钥',
    load: async (db) =>
      (
        await db.user.findMany({
          where: { totpSecret: { not: null } },
          select: { id: true, totpSecret: true },
        })
      ).map((r) => ({ id: r.id, value: r.totpSecret })),
    save: (db, id, value) => db.user.update({ where: { id }, data: { totpSecret: value } }),
  },
];

export interface RotationLine {
  label: string;
  total: number;
  /** 用旧密钥能解开、要重新加密的 */
  toRotate: number;
  /** 已经是新密钥加密的（重复执行时） */
  alreadyNew: number;
  /** 新旧密钥都解不开的记录 id */
  failed: string[];
}

export const isKeyHex = (v: string | undefined): v is string => !!v && /^[0-9a-fA-F]{64}$/.test(v);

export const boxOf = (hex: string) => new SecretBox(new ConfigService({ ACCOUNT_SECRET_KEY: hex }));

/**
 * 检查并（apply 时）重新加密。有任何一条新旧密钥都解不开就不写库，避免把数据弄成一半新一半旧。
 */
export async function rotateSecretKey(
  prisma: PrismaClient,
  oldBox: SecretBox,
  newBox: SecretBox,
  apply: boolean,
): Promise<{ lines: RotationLine[]; applied: boolean }> {
  const plan: { target: Target; id: string; value: string }[] = [];
  const lines: RotationLine[] = [];
  for (const target of SECRET_TARGETS) {
    const rows = await target.load(prisma);
    const line: RotationLine = {
      label: target.label,
      total: rows.length,
      toRotate: 0,
      alreadyNew: 0,
      failed: [],
    };
    for (const row of rows) {
      if (!row.value) continue;
      let plain: string | null = null;
      try {
        plain = oldBox.decrypt(row.value);
      } catch {
        try {
          newBox.decrypt(row.value);
          line.alreadyNew++;
        } catch {
          line.failed.push(row.id);
        }
      }
      if (plain !== null) {
        line.toRotate++;
        plan.push({ target, id: row.id, value: newBox.encrypt(plain) });
      }
    }
    lines.push(line);
  }
  const canApply = apply && lines.every((l) => l.failed.length === 0) && plan.length > 0;
  if (canApply) {
    await prisma.$transaction(
      async (tx) => {
        for (const p of plan) await p.target.save(tx, p.id, p.value);
      },
      { timeout: 120_000 },
    );
  }
  return { lines, applied: canApply };
}

async function main(): Promise<void> {
  const oldHex = process.env.OLD_ACCOUNT_SECRET_KEY?.trim();
  const newHex = process.env.ACCOUNT_SECRET_KEY?.trim();
  const apply = process.argv.includes('--apply');
  if (!isKeyHex(oldHex) || !isKeyHex(newHex)) {
    console.error(
      '请在 .env 里设置 OLD_ACCOUNT_SECRET_KEY（旧密钥）和 ACCOUNT_SECRET_KEY（新密钥），都是 64 位十六进制',
    );
    process.exit(2);
  }
  if (oldHex.toLowerCase() === newHex.toLowerCase()) {
    console.error('新旧密钥一样，不需要更换');
    process.exit(2);
  }
  const prisma = new PrismaClient();
  try {
    const { lines, applied } = await rotateSecretKey(prisma, boxOf(oldHex), boxOf(newHex), apply);
    for (const l of lines) {
      const failed = l.failed.length
        ? `，解不开 ${l.failed.length} 条（${l.failed.join('、')}）`
        : '';
      console.log(
        `${l.label}：共 ${l.total} 条，要重新加密 ${l.toRotate} 条，已经是新密钥 ${l.alreadyNew} 条${failed}`,
      );
    }
    const failed = lines.some((l) => l.failed.length > 0);
    const pending = lines.reduce((n, l) => n + l.toRotate, 0);
    if (failed) {
      console.error(
        '有记录新旧密钥都解不开，没有做任何修改。请确认 OLD_ACCOUNT_SECRET_KEY 是不是当时用的密钥',
      );
      process.exit(1);
    }
    if (pending === 0) console.log('没有需要重新加密的数据');
    else if (applied)
      console.log(
        `已用新密钥重新加密 ${pending} 条。请删掉 .env 里的 OLD_ACCOUNT_SECRET_KEY 后重启`,
      );
    else console.log('这是检查结果，没有修改数据。确认无误后加 --apply 执行');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) void main();
