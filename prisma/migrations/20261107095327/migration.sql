-- CreateTable
CREATE TABLE "scan_cache" (
    "id" TEXT NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "findingsJson" TEXT NOT NULL,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "lastAccessed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "scan_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scan_cache_cacheKey_key" ON "scan_cache"("cacheKey");

-- CreateIndex
CREATE INDEX "scan_cache_cacheKey_idx" ON "scan_cache"("cacheKey");

-- CreateIndex
CREATE INDEX "scan_cache_expiresAt_idx" ON "scan_cache"("expiresAt");
