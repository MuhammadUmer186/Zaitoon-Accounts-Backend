CREATE TABLE IF NOT EXISTS "BranchStockTransfer" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "sourceBranchId" TEXT NOT NULL, "destinationBranchId" TEXT NOT NULL,
 "sourceNodeId" TEXT NOT NULL, "destinationNodeId" TEXT NOT NULL, "actorId" TEXT NOT NULL,
 "digest" TEXT NOT NULL, "items" JSONB NOT NULL, "dispatch" JSONB, "state" TEXT NOT NULL DEFAULT 'queued', "error" TEXT,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "BranchStockTransfer_organizationId_state_createdAt_idx" ON "BranchStockTransfer"("organizationId","state","createdAt");
CREATE TABLE IF NOT EXISTS "BranchTransferReceipt" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "branchId" TEXT NOT NULL, "transferId" TEXT NOT NULL,
 "digest" TEXT NOT NULL, "result" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DROP TRIGGER IF EXISTS foodsync_branch_ownership ON "BranchTransferReceipt";
