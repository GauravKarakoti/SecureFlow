/*
  Warnings:

  - The `status` column on the `FindingTriage` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `severity` column on the `PolicyTemplate` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `state` column on the `PullRequest` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `status` column on the `PullRequest` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `policyDecision` column on the `ScanResult` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - Changed the type of `type` on the `Finding` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `severity` on the `Finding` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- CreateEnum
CREATE TYPE "FindingType" AS ENUM ('SECRET', 'VULNERABILITY', 'MISCONFIG');

-- CreateEnum
CREATE TYPE "FindingTriageStatus" AS ENUM ('OPEN', 'RESOLVED', 'FALSE_POSITIVE', 'IGNORED');

-- CreateEnum
CREATE TYPE "PolicyDecision" AS ENUM ('PASS', 'REVIEW', 'BLOCK');

-- CreateEnum
CREATE TYPE "PRStatus" AS ENUM ('PASS', 'REVIEW_REQUIRED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "PRState" AS ENUM ('OPEN', 'CLOSED', 'MERGED');

-- AlterTable
ALTER TABLE "Finding" DROP COLUMN "type",
ADD COLUMN     "type" "FindingType" NOT NULL,
DROP COLUMN "severity",
ADD COLUMN     "severity" "FindingSeverity" NOT NULL;

-- AlterTable
ALTER TABLE "FindingTriage" DROP COLUMN "status",
ADD COLUMN     "status" "FindingTriageStatus" NOT NULL DEFAULT 'OPEN';

-- AlterTable
ALTER TABLE "PolicyTemplate" DROP COLUMN "severity",
ADD COLUMN     "severity" "FindingSeverity" NOT NULL DEFAULT 'HIGH';

-- AlterTable
ALTER TABLE "PullRequest" DROP COLUMN "state",
ADD COLUMN     "state" "PRState" NOT NULL DEFAULT 'OPEN',
DROP COLUMN "status",
ADD COLUMN     "status" "PRStatus" NOT NULL DEFAULT 'REVIEW_REQUIRED';

-- AlterTable
ALTER TABLE "ScanResult" DROP COLUMN "policyDecision",
ADD COLUMN     "policyDecision" "PolicyDecision" NOT NULL DEFAULT 'REVIEW';

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
