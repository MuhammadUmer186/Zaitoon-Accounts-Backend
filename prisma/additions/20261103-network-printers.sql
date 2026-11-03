-- Local printing configuration/control plane: never replicate credentials or
-- dispatch queues between the cloud and branch PCs.
CREATE TABLE IF NOT EXISTS "NetworkKitchenPrinter" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "stationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "host" TEXT NOT NULL,
  "port" INTEGER NOT NULL DEFAULT 9100,
  "paperWidth" INTEGER NOT NULL DEFAULT 80,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "deliveryMode" TEXT NOT NULL,
  "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "agentTokenHash" TEXT,
  "agentInstanceId" TEXT,
  "dispatcherLabel" TEXT,
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "NetworkKitchenPrinter_organizationId_branchId_stationId_key"
  ON "NetworkKitchenPrinter" ("organizationId", "branchId", "stationId");
CREATE UNIQUE INDEX IF NOT EXISTS "NetworkKitchenPrinter_organizationId_branchId_host_port_key"
  ON "NetworkKitchenPrinter" ("organizationId", "branchId", "host", "port");
-- Installations created before explicit dispatcher handover.
ALTER TABLE "NetworkKitchenPrinter" ADD COLUMN IF NOT EXISTS "dispatcherLabel" TEXT;
