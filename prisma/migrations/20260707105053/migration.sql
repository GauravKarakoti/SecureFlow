/*
  Warnings:

  - A unique constraint covering the columns `[codename]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "codename" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_codename_key" ON "User"("codename");
