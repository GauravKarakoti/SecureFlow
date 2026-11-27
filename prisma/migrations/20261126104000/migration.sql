-- AlterTable PolicyTemplate
ALTER TABLE "PolicyTemplate" ADD COLUMN "helpUrl" TEXT,
ADD COLUMN "guidance" TEXT;

-- AlterTable PolicyVersion
ALTER TABLE "PolicyVersion" ADD COLUMN "helpUrl" TEXT,
ADD COLUMN "guidance" TEXT;
