-- Full ERP replica transport and local consistent-checkpoint revision.
ALTER TABLE "BranchRuntime" ADD COLUMN IF NOT EXISTS "dataRevision" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "BranchRuntime" ADD COLUMN IF NOT EXISTS "lastReplicaRevision" BIGINT NOT NULL DEFAULT -1;
ALTER TABLE "BranchRuntime" ADD COLUMN IF NOT EXISTS "lastReplicaAt" TIMESTAMP(3);
ALTER TABLE "BranchRuntime" ADD COLUMN IF NOT EXISTS "syncHr" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "replicaRevision" BIGINT NOT NULL DEFAULT -1;
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "replicaAt" TIMESTAMP(3);
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "reportedDataRevision" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "syncHr" BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS "BranchReplicaSession" (
 "id" TEXT PRIMARY KEY, "nodeId" TEXT NOT NULL, "revision" BIGINT NOT NULL, "schema" TEXT NOT NULL,
 "manifest" JSONB NOT NULL, "digest" TEXT NOT NULL, "committedAt" TIMESTAMP(3), "expiresAt" TIMESTAMP(3) NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE("nodeId","revision")
);
CREATE INDEX IF NOT EXISTS "BranchReplicaSession_expiresAt_idx" ON "BranchReplicaSession"("expiresAt");
CREATE TABLE IF NOT EXISTS "BranchReplicaPart" (
 "id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL, "entity" TEXT NOT NULL, "part" INTEGER NOT NULL,
 "rows" JSONB NOT NULL, "digest" TEXT NOT NULL, UNIQUE("sessionId","entity","part")
);
CREATE INDEX IF NOT EXISTS "BranchReplicaPart_sessionId_idx" ON "BranchReplicaPart"("sessionId");
CREATE OR REPLACE FUNCTION foodsync_replica_revision() RETURNS trigger AS $$
DECLARE branch TEXT; runtime "BranchRuntime";
BEGIN
 SELECT * INTO runtime FROM "BranchRuntime" WHERE "id"='local';
 IF NOT FOUND THEN RETURN NULL; END IF;
 branch:=foodsync_parent_branch(TG_TABLE_NAME,CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END);
 IF branch=runtime."branchId" THEN UPDATE "BranchRuntime" SET "dataRevision"="dataRevision"+1 WHERE "id"='local'; END IF;
 RETURN NULL;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "BranchSection";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "BranchSection" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "JournalEntry";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "JournalEntry" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "JournalLine";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "JournalLine" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "DailySale";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "DailySale" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "DeliveryBreakdown";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "DeliveryBreakdown" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "CashClosing";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "CashClosing" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "Expense";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "Expense" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "Bill";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "Bill" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "BillItem";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "BillItem" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "Payment";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "Payment" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "BranchStock";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "BranchStock" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "StockMovement";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "StockMovement" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "StockOut";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "StockOut" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "WastageReport";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "WastageReport" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "WastageItem";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "WastageItem" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "PurchaseOrder";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "PurchaseOrder" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "PurchaseOrderItem";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "PurchaseOrderItem" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "DishOutOfStock";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "DishOutOfStock" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "DiningTable";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "DiningTable" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "CustomerOrder";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "CustomerOrder" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "CustomerOrderItem";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "CustomerOrderItem" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "OrderCheck";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "OrderCheck" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "DeliveryZone";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "DeliveryZone" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "Rider";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "Rider" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "DeliveryEvent";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "DeliveryEvent" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "RiderCashCollection";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "RiderCashCollection" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "RiderSettlement";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "RiderSettlement" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "TillSession";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "TillSession" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "TillMovement";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "TillMovement" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "TillPayment";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "TillPayment" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "ZReport";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "ZReport" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "OrderReview";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "OrderReview" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "HrEmployee";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "HrEmployee" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "HrRecord";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "HrRecord" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "HrAttendance";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "HrAttendance" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "HrLeaveRequest";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "HrLeaveRequest" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "HrPayrollRun";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "HrPayrollRun" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "HrPayrollLine";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "HrPayrollLine" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "HrPayrollPayment";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "HrPayrollPayment" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();

CREATE TABLE IF NOT EXISTS "BranchRemoteCommand" (
 "id" TEXT PRIMARY KEY, "nodeId" TEXT NOT NULL, "organizationId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
 "key" TEXT NOT NULL, "publicId" TEXT, "kind" TEXT NOT NULL, "digest" TEXT NOT NULL, "payload" JSONB NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'queued', "claimToken" TEXT, "leaseUntil" TIMESTAMP(3), "expiresAt" TIMESTAMP(3) NOT NULL,
 "responseStatus" INTEGER, "result" JSONB, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3),
 UNIQUE("nodeId","key")
);
CREATE INDEX IF NOT EXISTS "BranchRemoteCommand_nodeId_status_createdAt_idx" ON "BranchRemoteCommand"("nodeId","status","createdAt");
CREATE INDEX IF NOT EXISTS "BranchRemoteCommand_publicId_idx" ON "BranchRemoteCommand"("publicId");
