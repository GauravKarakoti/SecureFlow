-- CreateTable
CREATE TABLE "audio_debrief_cache" (
    "id" TEXT NOT NULL,
    "findingId" TEXT,
    "contentHash" TEXT NOT NULL,
    "audioBase64" TEXT NOT NULL,
    "format" TEXT NOT NULL DEFAULT 'audio/mpeg',
    "fileSize" INTEGER NOT NULL DEFAULT 0,
    "durationSec" DOUBLE PRECISION,
    "source" TEXT NOT NULL DEFAULT 'elevenlabs',
    "storageUrl" TEXT,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "lastAccessed" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "audio_debrief_cache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "audio_debrief_cache_contentHash_key" ON "audio_debrief_cache"("contentHash");

-- CreateIndex
CREATE INDEX "audio_debrief_cache_findingId_idx" ON "audio_debrief_cache"("findingId");

-- CreateIndex
CREATE INDEX "audio_debrief_cache_contentHash_idx" ON "audio_debrief_cache"("contentHash");

-- CreateIndex
CREATE INDEX "audio_debrief_cache_createdAt_idx" ON "audio_debrief_cache"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "audio_debrief_cache_lastAccessed_idx" ON "audio_debrief_cache"("lastAccessed" DESC);
