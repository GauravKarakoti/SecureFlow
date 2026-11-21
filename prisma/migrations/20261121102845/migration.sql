-- AlterTable
ALTER TABLE "Finding" ADD COLUMN     "suppressionRuleId" TEXT,
ADD COLUMN     "suppressionStatus" TEXT;

-- CreateTable
CREATE TABLE "SuppressionRule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'ALL',
    "repositoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "matchPolicy" TEXT,
    "matchCategory" TEXT,
    "pathGlob" TEXT,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SuppressionRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuppressionRuleEvent" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "repositoryId" TEXT,
    "findingFingerprint" TEXT,
    "fileLocation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuppressionRuleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SuppressionRule_createdAt_idx" ON "SuppressionRule"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "SuppressionRule_expiresAt_idx" ON "SuppressionRule"("expiresAt");

-- CreateIndex
CREATE INDEX "SuppressionRule_scope_idx" ON "SuppressionRule"("scope");

-- CreateIndex
CREATE INDEX "SuppressionRuleEvent_ruleId_createdAt_idx" ON "SuppressionRuleEvent"("ruleId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "SuppressionRuleEvent_createdAt_idx" ON "SuppressionRuleEvent"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "Finding_suppressionStatus_idx" ON "Finding"("suppressionStatus");

-- CreateIndex
CREATE INDEX "Finding_suppressionRuleId_idx" ON "Finding"("suppressionRuleId");

-- AddForeignKey
ALTER TABLE "SuppressionRule" ADD CONSTRAINT "SuppressionRule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuppressionRuleEvent" ADD CONSTRAINT "SuppressionRuleEvent_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "SuppressionRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
