-- AlterTable
ALTER TABLE "User" ADD COLUMN     "slackWebhookUrl" TEXT;

-- CreateIndex
CREATE INDEX "AuditLog_action_timestamp_idx" ON "AuditLog"("action", "timestamp" DESC);
