-- CreateTable
CREATE TABLE "AuditEventLedger" (
    "id" TEXT NOT NULL,
    "sequenceNum" SERIAL NOT NULL,
    "action" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "previousHash" TEXT NOT NULL,
    "currentHash" TEXT NOT NULL,

    CONSTRAINT "AuditEventLedger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AuditEventLedger_sequenceNum_key" ON "AuditEventLedger"("sequenceNum");

-- CreateIndex
CREATE UNIQUE INDEX "AuditEventLedger_currentHash_key" ON "AuditEventLedger"("currentHash");
