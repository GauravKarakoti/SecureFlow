/*
  Warnings:

  - You are about to drop the `Policy` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "Policy" DROP CONSTRAINT "Policy_userId_fkey";

-- DropTable
DROP TABLE "Policy";

-- CreateTable
CREATE TABLE "PolicyTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'HIGH',
    "action" TEXT NOT NULL DEFAULT 'REVIEW REQUIRED',
    "rules" JSONB NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPolicyToggle" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "policyTemplateId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPolicyToggle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserPolicyToggle_userId_policyTemplateId_key" ON "UserPolicyToggle"("userId", "policyTemplateId");

-- AddForeignKey
ALTER TABLE "UserPolicyToggle" ADD CONSTRAINT "UserPolicyToggle_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPolicyToggle" ADD CONSTRAINT "UserPolicyToggle_policyTemplateId_fkey" FOREIGN KEY ("policyTemplateId") REFERENCES "PolicyTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
