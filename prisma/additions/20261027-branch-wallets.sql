CREATE TABLE IF NOT EXISTS "BranchWalletReservation" (
 "id" TEXT PRIMARY KEY, "nodeId" TEXT NOT NULL, "organizationId" TEXT NOT NULL,
 "branchId" TEXT NOT NULL, "orderId" TEXT NOT NULL, "reference" TEXT NOT NULL,
 "digest" TEXT NOT NULL, "payload" JSONB NOT NULL, "state" TEXT NOT NULL DEFAULT 'reserved',
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "BranchWalletReservation_nodeId_state_createdAt_idx" ON "BranchWalletReservation"("nodeId","state","createdAt");
CREATE TABLE IF NOT EXISTS "BranchWalletReceipt" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
 "orderId" TEXT NOT NULL, "reference" TEXT NOT NULL, "payload" JSONB NOT NULL,
 "refunded" BOOLEAN NOT NULL DEFAULT FALSE, "acknowledged" BOOLEAN NOT NULL DEFAULT FALSE,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "BranchWalletReceipt_acknowledged_createdAt_idx" ON "BranchWalletReceipt"("acknowledged","createdAt");
CREATE INDEX IF NOT EXISTS "BranchWalletReceipt_orderId_idx" ON "BranchWalletReceipt"("orderId");
-- These are protocol receipts, not replicas of business tables.
DROP TRIGGER IF EXISTS foodsync_branch_ownership ON "BranchWalletReservation";
DROP TRIGGER IF EXISTS foodsync_branch_ownership ON "BranchWalletReceipt";
-- Vouchers stay central; branch staff/public forms relay to the one authority.
DROP TRIGGER IF EXISTS foodsync_branch_ownership ON "FreeDishQr";
DROP TRIGGER IF EXISTS foodsync_branch_ownership ON "FreeDishSubmission";

-- Restore detection. On the PC a sequence advances outside transactions: a
-- rolled-back checkout never lowers it, while restoring a backup does. The
-- cloud remembers the highest position each PC has shown; a lower position
-- means the PC's database is behind its own past wallet activity.
CREATE SEQUENCE IF NOT EXISTS "BranchWalletSequence";
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "walletSequenceSeen" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "walletSequenceReported" BIGINT;
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "walletRestoreDetectedAt" TIMESTAMP(3);
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "walletRecoveryAcceptedAt" TIMESTAMP(3);
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "walletRecoveryAcceptedBy" TEXT;
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "walletRecoveryReason" TEXT;
-- One live or committed debit per payment reference; operator decisions audited.
ALTER TABLE "BranchWalletReservation" ADD COLUMN IF NOT EXISTS "sequence" BIGINT;
ALTER TABLE "BranchWalletReservation" ADD COLUMN IF NOT EXISTS "resolvedBy" TEXT;
ALTER TABLE "BranchWalletReservation" ADD COLUMN IF NOT EXISTS "resolutionReason" TEXT;
ALTER TABLE "BranchWalletReservation" ADD COLUMN IF NOT EXISTS "resolvedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "BranchWalletReservation_organizationId_reference_state_idx" ON "BranchWalletReservation"("organizationId","reference","state");
-- Gift-card sales and house-account payments taken at a branch replicate to the
-- central ERP with their journals.
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "CustomerReceipt";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "CustomerReceipt" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
