-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "codeScanningEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "codeScanningWarning" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "weeklyDigestEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_webhooks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[],
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbound_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_webhook_deliveries" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "statusCode" INTEGER,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_digests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "newFindingsCount" INTEGER NOT NULL DEFAULT 0,
    "dismissedFindingsCount" INTEGER NOT NULL DEFAULT 0,
    "resolvedFindingsCount" INTEGER NOT NULL DEFAULT 0,
    "blockedPrsCount" INTEGER NOT NULL DEFAULT 0,
    "topRepositories" JSONB NOT NULL DEFAULT '[]',
    "topFindingTypes" JSONB NOT NULL DEFAULT '[]',
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_digests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_tokenHash_key" ON "ApiToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiToken_userId_idx" ON "ApiToken"("userId");

-- CreateIndex
CREATE INDEX "ApiToken_tokenHash_idx" ON "ApiToken"("tokenHash");

-- CreateIndex
CREATE INDEX "ApiToken_userId_revokedAt_idx" ON "ApiToken"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "outbound_webhooks_userId_idx" ON "outbound_webhooks"("userId");

-- CreateIndex
CREATE INDEX "outbound_webhooks_userId_enabled_idx" ON "outbound_webhooks"("userId", "enabled");

-- CreateIndex
CREATE INDEX "outbound_webhook_deliveries_webhookId_idx" ON "outbound_webhook_deliveries"("webhookId");

-- CreateIndex
CREATE INDEX "outbound_webhook_deliveries_eventId_idx" ON "outbound_webhook_deliveries"("eventId");

-- CreateIndex
CREATE INDEX "outbound_webhook_deliveries_webhookId_createdAt_idx" ON "outbound_webhook_deliveries"("webhookId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "security_digests_userId_createdAt_idx" ON "security_digests"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "security_digests_createdAt_idx" ON "security_digests"("createdAt" DESC);

-- AddForeignKey
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_webhooks" ADD CONSTRAINT "outbound_webhooks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_webhook_deliveries" ADD CONSTRAINT "outbound_webhook_deliveries_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "outbound_webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_digests" ADD CONSTRAINT "security_digests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
