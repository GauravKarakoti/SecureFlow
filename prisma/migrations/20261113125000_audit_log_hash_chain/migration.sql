-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN "previousHash" TEXT,
ADD COLUMN "entryHash" TEXT;

-- CreateIndex
CREATE INDEX "AuditLog_entryHash_idx" ON "AuditLog"("entryHash");
