-- CreateEnum
CREATE TYPE "CommissionRole" AS ENUM ('DIRECT', 'PARENT');

-- CreateEnum
CREATE TYPE "CommissionKind" AS ENUM ('ACCRUAL', 'CLAWBACK');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('FROZEN', 'RELEASABLE', 'SETTLED', 'PAID', 'VOID');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "commissionCents" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "commissionReducedCents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "Commission" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "role" "CommissionRole" NOT NULL,
    "kind" "CommissionKind" NOT NULL DEFAULT 'ACCRUAL',
    "seq" INTEGER NOT NULL DEFAULT 1,
    "rateBp" INTEGER NOT NULL,
    "baseCents" INTEGER NOT NULL,
    "originalCents" INTEGER NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "status" "CommissionStatus" NOT NULL,
    "releaseAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "refundId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Commission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Commission_agentId_status_idx" ON "Commission"("agentId", "status");

-- CreateIndex
CREATE INDEX "Commission_orderId_idx" ON "Commission"("orderId");

-- CreateIndex
CREATE INDEX "Commission_status_releaseAt_idx" ON "Commission"("status", "releaseAt");

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE SET NULL ON UPDATE CASCADE;
