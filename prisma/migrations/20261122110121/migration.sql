-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "action" TEXT,
    "repository" TEXT,
    "outcome" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_deliveries_createdAt_idx" ON "webhook_deliveries"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "webhook_deliveries_repository_idx" ON "webhook_deliveries"("repository");

-- CreateIndex
CREATE INDEX "webhook_deliveries_outcome_idx" ON "webhook_deliveries"("outcome");

-- CreateIndex
CREATE INDEX "webhook_deliveries_deliveryId_idx" ON "webhook_deliveries"("deliveryId");

-- CreateIndex
CREATE INDEX "webhook_deliveries_reasonCode_idx" ON "webhook_deliveries"("reasonCode");
