-- CreateEnum
CREATE TYPE "TicketType" AS ENUM ('NOT_EFFECTIVE', 'BANNED', 'LIMITED', 'REFUND', 'REPLACE', 'OTHER');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'PAID', 'REJECTED');

-- AlterEnum
ALTER TYPE "TaskType" ADD VALUE 'REPLACE_ACCOUNT';

-- AlterTable
ALTER TABLE "FulfillmentTask" ADD COLUMN     "ticketId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "refundedCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "warrantyCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "withWarranty" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "warrantyPriceCents" INTEGER;

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "no" SERIAL NOT NULL,
    "type" "TicketType" NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "customerId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "orderId" TEXT,
    "description" TEXT NOT NULL,
    "customerFault" TEXT,
    "resolution" TEXT,
    "assigneeId" TEXT,
    "ownerId" TEXT NOT NULL,
    "teamId" TEXT,
    "createdById" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "escalatedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketEvent" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "no" SERIAL NOT NULL,
    "orderId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "ticketId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "terminate" BOOLEAN NOT NULL DEFAULT false,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "method" TEXT,
    "reference" TEXT,
    "paidAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "ownerId" TEXT NOT NULL,
    "teamId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_no_key" ON "Ticket"("no");

-- CreateIndex
CREATE INDEX "Ticket_status_dueAt_idx" ON "Ticket"("status", "dueAt");

-- CreateIndex
CREATE INDEX "Ticket_assigneeId_status_idx" ON "Ticket"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "Ticket_customerId_idx" ON "Ticket"("customerId");

-- CreateIndex
CREATE INDEX "Ticket_subscriptionId_idx" ON "Ticket"("subscriptionId");

-- CreateIndex
CREATE INDEX "Ticket_ownerId_idx" ON "Ticket"("ownerId");

-- CreateIndex
CREATE INDEX "Ticket_teamId_idx" ON "Ticket"("teamId");

-- CreateIndex
CREATE INDEX "TicketEvent_ticketId_createdAt_idx" ON "TicketEvent"("ticketId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_no_key" ON "Refund"("no");

-- CreateIndex
CREATE INDEX "Refund_status_createdAt_idx" ON "Refund"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Refund_orderId_idx" ON "Refund"("orderId");

-- CreateIndex
CREATE INDEX "Refund_paidAt_idx" ON "Refund"("paidAt");

-- CreateIndex
CREATE INDEX "FulfillmentTask_ticketId_idx" ON "FulfillmentTask"("ticketId");

-- AddForeignKey
ALTER TABLE "FulfillmentTask" ADD CONSTRAINT "FulfillmentTask_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketEvent" ADD CONSTRAINT "TicketEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketEvent" ADD CONSTRAINT "TicketEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 数据迁移：内置「客服」角色补上「登记售后工单」权限（M2 新增）
UPDATE "Role"
SET "permissions" = array_append("permissions", 'ticket:create')
WHERE "code" = 'sales' AND "builtIn" = true AND NOT ('ticket:create' = ANY ("permissions"));
