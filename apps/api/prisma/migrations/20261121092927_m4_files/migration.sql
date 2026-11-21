-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Attachment_storageKey_key" ON "Attachment"("storageKey");

-- CreateIndex
CREATE INDEX "Attachment_ownerType_ownerId_idx" ON "Attachment"("ownerType", "ownerId");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 内置「财务」角色新增「导出订单清单」权限（order:export），对账时用。
-- 只动内置财务角色，已有时不重复添加。
UPDATE "Role"
SET "permissions" = array_append("permissions", 'order:export'),
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'finance'
  AND "builtIn" = true
  AND NOT ('order:export' = ANY ("permissions"));
