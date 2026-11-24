-- AlterTable
ALTER TABLE "Finding" ADD COLUMN     "encryptionKeyId" TEXT;

-- CreateIndex
CREATE INDEX "Finding_encryptionKeyId_idx" ON "Finding"("encryptionKeyId");
