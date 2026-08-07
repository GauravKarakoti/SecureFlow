-- AlterTable
ALTER TABLE "PullRequest" ADD COLUMN     "authorAvatarUrl" TEXT,
ADD COLUMN     "authorLogin" TEXT;

-- CreateIndex
CREATE INDEX "PullRequest_authorLogin_idx" ON "PullRequest"("authorLogin");
