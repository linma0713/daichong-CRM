-- CreateEnum
CREATE TYPE "AccountStockStatus" AS ENUM ('IN_STOCK', 'IN_USE', 'VOID');

-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('VIRTUAL_CARD', 'GIFT_CARD', 'BALANCE');

-- CreateEnum
CREATE TYPE "ResourceTxType" AS ENUM ('TOP_UP', 'CONSUME', 'ADJUST');

-- CreateEnum
CREATE TYPE "CostKind" AS ENUM ('UPSTREAM_CHARGE', 'ACCOUNT_STOCK', 'OTHER');

-- AlterTable
ALTER TABLE "ClaudeAccount" ADD COLUMN     "planId" TEXT,
ADD COLUMN     "stockCostCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stockStatus" "AccountStockStatus",
ADD COLUMN     "stockedAt" TIMESTAMP(3),
ADD COLUMN     "upstreamRenewAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "costCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "feeCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "periodEndAt" TIMESTAMP(3),
ADD COLUMN     "periodStartAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "feeCents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PaymentResource" (
    "id" TEXT NOT NULL,
    "no" SERIAL NOT NULL,
    "type" "ResourceType" NOT NULL,
    "name" TEXT NOT NULL,
    "last4" TEXT,
    "balanceUsdCents" INTEGER NOT NULL DEFAULT 0,
    "costPoolCents" INTEGER NOT NULL DEFAULT 0,
    "feeBp" INTEGER NOT NULL DEFAULT 0,
    "feeFixedUsdCents" INTEGER NOT NULL DEFAULT 0,
    "lowBalanceUsdCents" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "secretNoteEnc" TEXT,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentResource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceTransaction" (
    "id" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "type" "ResourceTxType" NOT NULL,
    "usdCents" INTEGER NOT NULL,
    "cnyCents" INTEGER NOT NULL,
    "balanceAfterUsdCents" INTEGER NOT NULL,
    "note" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResourceTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostEntry" (
    "id" TEXT NOT NULL,
    "kind" "CostKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "usdCents" INTEGER,
    "orderId" TEXT,
    "subscriptionId" TEXT,
    "taskId" TEXT,
    "accountId" TEXT,
    "resourceTxId" TEXT,
    "note" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentResource_no_key" ON "PaymentResource"("no");

-- CreateIndex
CREATE INDEX "ResourceTransaction_resourceId_createdAt_idx" ON "ResourceTransaction"("resourceId", "createdAt");

-- CreateIndex
CREATE INDEX "ResourceTransaction_createdAt_idx" ON "ResourceTransaction"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CostEntry_resourceTxId_key" ON "CostEntry"("resourceTxId");

-- CreateIndex
CREATE INDEX "CostEntry_orderId_idx" ON "CostEntry"("orderId");

-- CreateIndex
CREATE INDEX "CostEntry_createdAt_idx" ON "CostEntry"("createdAt");

-- CreateIndex
CREATE INDEX "ClaudeAccount_stockStatus_planId_idx" ON "ClaudeAccount"("stockStatus", "planId");

-- AddForeignKey
ALTER TABLE "ClaudeAccount" ADD CONSTRAINT "ClaudeAccount_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceTransaction" ADD CONSTRAINT "ResourceTransaction_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "PaymentResource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceTransaction" ADD CONSTRAINT "ResourceTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostEntry" ADD CONSTRAINT "CostEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostEntry" ADD CONSTRAINT "CostEntry_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "FulfillmentTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostEntry" ADD CONSTRAINT "CostEntry_resourceTxId_fkey" FOREIGN KEY ("resourceTxId") REFERENCES "ResourceTransaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostEntry" ADD CONSTRAINT "CostEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 数据回填：M1 已有的成品号补上库存状态和套餐（使用中 / 回收后在库）
UPDATE "ClaudeAccount" a
SET "stockStatus" = CASE WHEN a."customerId" IS NULL THEN 'IN_STOCK'::"AccountStockStatus" ELSE 'IN_USE'::"AccountStockStatus" END,
    "planId" = (
      SELECT s."planId" FROM "Subscription" s
      WHERE s."accountId" = a.id ORDER BY s."createdAt" DESC LIMIT 1
    ),
    "stockedAt" = CASE WHEN a."customerId" IS NULL THEN a."updatedAt" ELSE NULL END
WHERE a.ownership = 'COMPANY';

-- 数据回填：已完成的新购订单，服务期 = 对应订阅的开始时间起算
UPDATE "Order" o
SET "periodStartAt" = s."startAt",
    "periodEndAt" = s."startAt" + make_interval(months => o."termMonths")
FROM "Subscription" s
WHERE o."subscriptionId" = s.id AND o.kind = 'NEW' AND o.status = 'COMPLETED' AND o."periodStartAt" IS NULL;
