-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "firstPaidAt" TIMESTAMP(3),
ADD COLUMN     "lastContactAt" TIMESTAMP(3),
ADD COLUMN     "lastPaidAt" TIMESTAMP(3),
ADD COLUMN     "lostNote" TEXT,
ADD COLUMN     "lostReason" TEXT,
ADD COLUMN     "lostReasonAt" TIMESTAMP(3),
ADD COLUMN     "netPaidCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "paidOrderCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "serviceEndAt" TIMESTAMP(3),
ADD COLUMN     "stage" TEXT NOT NULL DEFAULT 'LEAD',
ADD COLUMN     "stageChangedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ScriptTemplate" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "lastUsedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScriptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScriptTemplate_category_sortOrder_idx" ON "ScriptTemplate"("category", "sortOrder");

-- CreateIndex
CREATE INDEX "Customer_stage_serviceEndAt_idx" ON "Customer"("stage", "serviceEndAt");

-- CreateIndex
CREATE INDEX "Customer_netPaidCents_idx" ON "Customer"("netPaidCents");

-- AddForeignKey
ALTER TABLE "ScriptTemplate" ADD CONSTRAINT "ScriptTemplate_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── 数据补齐 ──
-- 客户的分层、累计实付、服务结束时间等由程序计算：API 启动时和每小时巡检都会刷新一次全部客户，这里不重复写计算逻辑。
-- 最近联系时间从已有的跟进记录补上。
UPDATE "Customer" c
SET "lastContactAt" = f.last_at
FROM (SELECT "customerId", MAX("createdAt") AS last_at FROM "FollowUp" GROUP BY "customerId") f
WHERE f."customerId" = c.id;

-- 内置「客服」角色新增「管理话术库」权限（script:write）。只动内置客服角色，已有时不重复添加。
UPDATE "Role"
SET "permissions" = array_append("permissions", 'script:write'),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'sales'
  AND "builtIn" = true
  AND NOT ('script:write' = ANY ("permissions"));

-- 话术库默认几条，管理员可以在「话术库」里改
INSERT INTO "ScriptTemplate" ("id", "category", "title", "content", "sortOrder", "updatedAt") VALUES
('script_default_renewal_1', 'renewal', '到期前提醒',
 E'{客户称呼}您好，您的 Claude {套餐}（账号 {账号}）将在 {到期日} 到期，还剩 {剩余天数} 天。\n续费价 {续费价}，现在续费服务不中断，到期当天也不用再操心。需要的话回复我，马上给您安排～',
 10, CURRENT_TIMESTAMP),
('script_default_renewal_2', 'renewal', '到期当天 / 刚到期',
 E'{客户称呼}您好，您的 Claude {套餐} 今天到期了（{到期日}）。如果还要继续用，回复我就能马上给您续上，不耽误使用。',
 20, CURRENT_TIMESTAMP),
('script_default_recall_1', 'recall', '服务结束后回访',
 E'{客户称呼}您好，我是之前帮您开通 Claude 的{客服}。您的服务结束有一段时间了，最近还有在用 AI 写代码 / 写东西吗？\n想继续用的话回复我，当天就能给您安排上。',
 10, CURRENT_TIMESTAMP),
('script_default_recall_2', 'recall', '老客户回归',
 E'{客户称呼}您好，好久不见～ 最近 Claude 又更新了不少新功能，有需要随时找我，老客户优先安排。',
 20, CURRENT_TIMESTAMP),
('script_default_delivery_1', 'delivery', '开通完成通知',
 E'{客户称呼}您好，您的 Claude {套餐} 已经开通好了 ✅\n账号：{账号}\n服务到期：{到期日}\n登录后有任何问题直接找我，到期前我会提前提醒您续费。',
 10, CURRENT_TIMESTAMP);
