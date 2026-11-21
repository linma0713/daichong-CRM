-- CreateEnum
CREATE TYPE "StatementStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'PAID', 'CANCELLED');

-- AlterTable
ALTER TABLE "Commission" ADD COLUMN     "statementId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "agentId" TEXT,
ADD COLUMN     "statementId" TEXT;

-- CreateTable
CREATE TABLE "CommissionStatement" (
    "id" TEXT NOT NULL,
    "no" SERIAL NOT NULL,
    "agentId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "cutoffAt" TIMESTAMP(3) NOT NULL,
    "status" "StatementStatus" NOT NULL DEFAULT 'DRAFT',
    "commissionCents" INTEGER NOT NULL DEFAULT 0,
    "collectedCents" INTEGER NOT NULL DEFAULT 0,
    "payableCents" INTEGER NOT NULL DEFAULT 0,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "paidById" TEXT,
    "paidAt" TIMESTAMP(3),
    "payMethod" TEXT,
    "payReference" TEXT,
    "createdById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionStatement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommissionStatement_no_key" ON "CommissionStatement"("no");

-- CreateIndex
CREATE INDEX "CommissionStatement_agentId_month_idx" ON "CommissionStatement"("agentId", "month");

-- CreateIndex
CREATE INDEX "CommissionStatement_status_idx" ON "CommissionStatement"("status");

-- CreateIndex
CREATE INDEX "Commission_statementId_idx" ON "Commission"("statementId");

-- CreateIndex
CREATE INDEX "Payment_agentId_statementId_idx" ON "Payment"("agentId", "statementId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "CommissionStatement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "CommissionStatement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionStatement" ADD CONSTRAINT "CommissionStatement_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionStatement" ADD CONSTRAINT "CommissionStatement_confirmedById_fkey" FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionStatement" ADD CONSTRAINT "CommissionStatement_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommissionStatement" ADD CONSTRAINT "CommissionStatement_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
