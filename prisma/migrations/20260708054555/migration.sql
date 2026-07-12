-- AlterTable
ALTER TABLE "WebhookEvent" ADD COLUMN     "pullRequestId" TEXT,
ADD COLUMN     "repositoryId" TEXT;

-- CreateIndex
CREATE INDEX "WebhookEvent_repositoryId_idx" ON "WebhookEvent"("repositoryId");

-- CreateIndex
CREATE INDEX "WebhookEvent_pullRequestId_idx" ON "WebhookEvent"("pullRequestId");

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvent" ADD CONSTRAINT "WebhookEvent_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "PullRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
