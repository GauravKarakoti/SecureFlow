-- AlterTable
ALTER TABLE "ScanJob" ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3),
ADD COLUMN     "processingToken" TEXT;
