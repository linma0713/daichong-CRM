-- AlterTable
ALTER TABLE "PaymentResource" ADD COLUMN     "cardNumberEnc" TEXT,
ADD COLUMN     "holderName" TEXT;

-- AlterTable
ALTER TABLE "ResourceTransaction" ADD COLUMN     "accountId" TEXT;

-- CreateIndex
CREATE INDEX "ResourceTransaction_accountId_idx" ON "ResourceTransaction"("accountId");

-- AddForeignKey
ALTER TABLE "ResourceTransaction" ADD CONSTRAINT "ResourceTransaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "ClaudeAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 老数据：成品号备号、在库续费的扣费当时只在备注里写了邮箱，按备注补上关联的成品号，
-- 这样已经发出去的成品号订单也能查到当时用的哪张卡
UPDATE "ResourceTransaction" t
SET "accountId" = a."id"
FROM "ClaudeAccount" a
WHERE t."accountId" IS NULL
  AND t."type" = 'CONSUME'
  AND t."note" IN ('成品号备号：' || a."email", '成品号在库续费：' || a."email");

-- 新权限「查看付款卡完整卡号」：内置充值员角色本来就负责用卡扣费，默认给上。
-- 内置角色只在第一次初始化时创建，老库在这里补；已有该权限时不重复添加，管理员改过的权限不受影响。
UPDATE "Role"
SET "permissions" = array_append("permissions", 'resource:card:view'),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'fulfillment'
  AND "builtIn" = true
  AND NOT ('resource:card:view' = ANY ("permissions"));
