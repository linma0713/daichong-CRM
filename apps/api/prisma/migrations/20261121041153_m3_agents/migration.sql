-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "agentBoundAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "agentId" TEXT,
ADD COLUMN     "agentRateBp" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "commissionBaseCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "firstOrder" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "parentAgentId" TEXT,
ADD COLUMN     "parentRateBp" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "firstRateBp" INTEGER,
ADD COLUMN     "parentRateBp" INTEGER,
ADD COLUMN     "renewalRateBp" INTEGER;

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "no" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "wechat" TEXT,
    "phone" TEXT,
    "parentId" TEXT,
    "status" "AgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "firstRateBp" INTEGER,
    "renewalRateBp" INTEGER,
    "parentRateBp" INTEGER,
    "payoutMethod" TEXT,
    "payoutAccount" TEXT,
    "remark" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Agent_no_key" ON "Agent"("no");

-- CreateIndex
CREATE INDEX "Agent_parentId_idx" ON "Agent"("parentId");

-- CreateIndex
CREATE INDEX "Customer_agentId_idx" ON "Customer"("agentId");

-- CreateIndex
CREATE INDEX "Order_agentId_idx" ON "Order"("agentId");

-- CreateIndex
CREATE INDEX "Order_parentAgentId_idx" ON "Order"("parentAgentId");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_parentAgentId_fkey" FOREIGN KEY ("parentAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
