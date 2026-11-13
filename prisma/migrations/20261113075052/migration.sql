-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "entryHash" TEXT,
ADD COLUMN     "previousHash" TEXT;

-- CreateIndex
CREATE INDEX "AuditLog_entryHash_idx" ON "AuditLog"("entryHash");
