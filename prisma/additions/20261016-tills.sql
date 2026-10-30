ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "requireTillForCash" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "posPin" TEXT;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "posPinLookup" TEXT;

ALTER TABLE "CustomerOrder" ADD COLUMN IF NOT EXISTS "tillSessionId" TEXT;

CREATE TABLE IF NOT EXISTS "TillSession" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceName" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingFloat" DOUBLE PRECISION NOT NULL,
    "closedAt" TIMESTAMP(3),
    "countedCash" DOUBLE PRECISION,
    "expectedCash" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "difference" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'open',
    "notes" TEXT,

    CONSTRAINT "TillSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TillMovement" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TillMovement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "TillPayment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT,
    "orderId" TEXT NOT NULL,
    "referenceKey" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TillPayment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ZReport" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "report" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ZReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VoidReason" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "VoidReason_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PosApproval" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "cashierId" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosApproval_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TillSession_organizationId_branchId_userId_status_idx" ON "TillSession"("organizationId", "branchId", "userId", "status");

CREATE INDEX IF NOT EXISTS "TillMovement_sessionId_idx" ON "TillMovement"("sessionId");

CREATE UNIQUE INDEX IF NOT EXISTS "TillPayment_referenceKey_key" ON "TillPayment"("referenceKey");

CREATE INDEX IF NOT EXISTS "TillPayment_sessionId_idx" ON "TillPayment"("sessionId");

CREATE INDEX IF NOT EXISTS "TillPayment_orderId_idx" ON "TillPayment"("orderId");

CREATE UNIQUE INDEX IF NOT EXISTS "ZReport_sessionId_key" ON "ZReport"("sessionId");

CREATE UNIQUE INDEX IF NOT EXISTS "ZReport_branchId_number_key" ON "ZReport"("branchId", "number");

CREATE UNIQUE INDEX IF NOT EXISTS "VoidReason_organizationId_name_key" ON "VoidReason"("organizationId", "name");

CREATE INDEX IF NOT EXISTS "PosApproval_expiresAt_idx" ON "PosApproval"("expiresAt");

CREATE UNIQUE INDEX IF NOT EXISTS "User_organizationId_posPinLookup_key" ON "User"("organizationId", "posPinLookup");

ALTER TABLE "CustomerOrder" ADD CONSTRAINT "CustomerOrder_tillSessionId_fkey" FOREIGN KEY ("tillSessionId") REFERENCES "TillSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "TillMovement" ADD CONSTRAINT "TillMovement_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TillSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TillPayment" ADD CONSTRAINT "TillPayment_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TillSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ZReport" ADD CONSTRAINT "ZReport_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "TillSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
