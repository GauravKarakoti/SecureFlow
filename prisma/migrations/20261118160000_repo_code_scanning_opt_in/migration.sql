-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "codeScanningEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "codeScanningWarning" TEXT;
