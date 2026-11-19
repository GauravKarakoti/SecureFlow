-- AlterTable
ALTER TABLE "User" ADD COLUMN "weeklyDigestEnabled" BOOLEAN NOT NULL DEFAULT true;

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
CREATE INDEX "security_digests_userId_createdAt_idx" ON "security_digests"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "security_digests_createdAt_idx" ON "security_digests"("createdAt" DESC);

-- AddForeignKey
ALTER TABLE "security_digests" ADD CONSTRAINT "security_digests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
