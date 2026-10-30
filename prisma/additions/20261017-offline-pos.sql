ALTER TABLE "CustomerOrder" ADD COLUMN IF NOT EXISTS "offlineOrderNo" TEXT;

ALTER TABLE "CustomerOrder" ADD COLUMN IF NOT EXISTS "offlineSyncedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "PosOfflineDevice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PosOfflineDevice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "OfflineOrderSync" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clientUuid" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "userId" TEXT NOT NULL,
    "baseHash" TEXT NOT NULL,
    "paymentHash" TEXT,
    "orderId" TEXT NOT NULL,
    "clientCreatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfflineOrderSync_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PosOfflineDevice_organizationId_branchId_idx" ON "PosOfflineDevice"("organizationId", "branchId");

CREATE UNIQUE INDEX IF NOT EXISTS "PosOfflineDevice_organizationId_number_key" ON "PosOfflineDevice"("organizationId", "number");

CREATE UNIQUE INDEX IF NOT EXISTS "OfflineOrderSync_orderId_key" ON "OfflineOrderSync"("orderId");

CREATE UNIQUE INDEX IF NOT EXISTS "OfflineOrderSync_organizationId_clientUuid_key" ON "OfflineOrderSync"("organizationId", "clientUuid");

CREATE UNIQUE INDEX IF NOT EXISTS "OfflineOrderSync_deviceId_sequence_key" ON "OfflineOrderSync"("deviceId", "sequence");

ALTER TABLE "OfflineOrderSync" ADD CONSTRAINT "OfflineOrderSync_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "PosOfflineDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OfflineOrderSync" ADD CONSTRAINT "OfflineOrderSync_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CustomerOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
