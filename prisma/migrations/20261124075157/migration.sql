-- AlterTable
ALTER TABLE "Finding" ADD COLUMN     "cwe" TEXT,
ADD COLUMN     "isBaseline" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tag" TEXT;

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "baselineFileLimit" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "baselineFrequency" TEXT NOT NULL DEFAULT 'weekly',
ADD COLUMN     "baselineScanEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastBaselineScanAt" TIMESTAMP(3),
ADD COLUMN     "lastBaselineScanStatus" TEXT;

-- AlterTable
ALTER TABLE "ScanResult" ADD COLUMN     "scanType" TEXT NOT NULL DEFAULT 'PR';

-- CreateTable
CREATE TABLE "installation_settings" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL DEFAULT 'default',
    "gateBlockOn" TEXT,
    "gateReviewOn" TEXT,
    "minCommentConfidence" TEXT,
    "includeDefaults" BOOLEAN,
    "skipDrafts" BOOLEAN,
    "skipAuthors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lockedSettings" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "installation_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "installation_settings_installationId_key" ON "installation_settings"("installationId");

-- CreateIndex
CREATE INDEX "installation_settings_installationId_idx" ON "installation_settings"("installationId");

-- CreateIndex
CREATE INDEX "Finding_tag_idx" ON "Finding"("tag");

-- CreateIndex
CREATE INDEX "Finding_isBaseline_idx" ON "Finding"("isBaseline");

-- CreateIndex
CREATE INDEX "ScanResult_scanType_idx" ON "ScanResult"("scanType");
