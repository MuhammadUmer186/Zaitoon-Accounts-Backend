-- Additive branch runtime and cloud inbox tables. Never drops application data.
CREATE TABLE IF NOT EXISTS "BranchRuntime" (
 "id" TEXT PRIMARY KEY DEFAULT 'local', "nodeId" TEXT NOT NULL UNIQUE,
 "organizationId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
 "lastSequence" BIGINT NOT NULL DEFAULT 0, "lastSyncedAt" TIMESTAMP(3), "lastError" TEXT
);
CREATE TABLE IF NOT EXISTS "BranchOutbox" (
 "id" TEXT PRIMARY KEY, "nodeId" TEXT NOT NULL, "sequence" BIGINT NOT NULL,
 "entity" TEXT NOT NULL, "entityId" TEXT NOT NULL, "operation" TEXT NOT NULL,
 "payload" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "acknowledgedAt" TIMESTAMP(3),
 UNIQUE ("nodeId", "sequence")
);
CREATE INDEX IF NOT EXISTS "BranchOutbox_acknowledgedAt_sequence_idx" ON "BranchOutbox"("acknowledgedAt", "sequence");
CREATE TABLE IF NOT EXISTS "BranchSyncNode" (
 "id" TEXT PRIMARY KEY, "organizationId" TEXT NOT NULL, "branchId" TEXT NOT NULL,
 "name" TEXT NOT NULL, "tokenHash" TEXT NOT NULL UNIQUE, "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
 "lastSequence" BIGINT NOT NULL DEFAULT 0, "lastSeenAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "BranchSyncNode_organizationId_branchId_idx" ON "BranchSyncNode"("organizationId", "branchId");
CREATE TABLE IF NOT EXISTS "BranchSyncEvent" (
 "id" TEXT PRIMARY KEY, "nodeId" TEXT NOT NULL, "sequence" BIGINT NOT NULL, "digest" TEXT NOT NULL,
 "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE ("nodeId", "sequence")
);
CREATE TABLE IF NOT EXISTS "BranchSyncProjection" (
 "id" TEXT PRIMARY KEY, "nodeId" TEXT NOT NULL, "entity" TEXT NOT NULL, "entityId" TEXT NOT NULL,
 "sequence" BIGINT NOT NULL, "payload" JSONB NOT NULL, "deleted" BOOLEAN NOT NULL DEFAULT FALSE,
 "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE ("nodeId", "entity", "entityId")
);
CREATE OR REPLACE FUNCTION foodsync_branch_enqueue(entity TEXT, operation TEXT, data JSONB) RETURNS VOID AS $$
DECLARE runtime "BranchRuntime"; next_sequence BIGINT; safe_data JSONB;
BEGIN
 SELECT * INTO runtime FROM "BranchRuntime" WHERE "id"='local';
 IF NOT FOUND OR data->>'organizationId' IS DISTINCT FROM runtime."organizationId" OR data->>'branchId' IS DISTINCT FROM runtime."branchId" THEN RETURN; END IF;
 -- The singleton row lock serializes the event stream until the business
 -- transaction commits. Rollbacks undo both sequence and outbox insert.
 UPDATE "BranchRuntime" SET "lastSequence"="lastSequence"+1 WHERE "id"='local' RETURNING "lastSequence" INTO next_sequence;
 SELECT jsonb_object_agg(key,value) INTO safe_data FROM jsonb_each(data) WHERE key = ANY(ARRAY[
 'id','organizationId','branchId','saleNo','saleDate','netAmount','totalAmount','cashAmount','cardAmount','vatAmount','refundAmount',
 'orderNo','orderType','status','createdAt','updatedAt','closedAt','expenseNo','expenseDate','amount',
 'closingNo','closingDate','expectedCash','actualCashCounted','difference','differenceType',
 'itemId','movementType','quantity','unitCost','totalValue','referenceType','referenceId'
 ]);
 INSERT INTO "BranchOutbox" ("id","nodeId","sequence","entity","entityId","operation","payload")
 VALUES (gen_random_uuid()::text,runtime."nodeId",next_sequence,entity,data->>'id',operation,safe_data);
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION foodsync_branch_capture() RETURNS trigger AS $$
BEGIN
 PERFORM foodsync_branch_enqueue(TG_TABLE_NAME,TG_OP,CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END);
 RETURN NULL;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS foodsync_branch_capture ON "DailySale";
CREATE TRIGGER foodsync_branch_capture AFTER INSERT OR UPDATE OR DELETE ON "DailySale" FOR EACH ROW EXECUTE FUNCTION foodsync_branch_capture();
DROP TRIGGER IF EXISTS foodsync_branch_capture ON "CustomerOrder";
CREATE TRIGGER foodsync_branch_capture AFTER INSERT OR UPDATE OR DELETE ON "CustomerOrder" FOR EACH ROW EXECUTE FUNCTION foodsync_branch_capture();
DROP TRIGGER IF EXISTS foodsync_branch_capture ON "Expense";
CREATE TRIGGER foodsync_branch_capture AFTER INSERT OR UPDATE OR DELETE ON "Expense" FOR EACH ROW EXECUTE FUNCTION foodsync_branch_capture();
DROP TRIGGER IF EXISTS foodsync_branch_capture ON "CashClosing";
CREATE TRIGGER foodsync_branch_capture AFTER INSERT OR UPDATE OR DELETE ON "CashClosing" FOR EACH ROW EXECUTE FUNCTION foodsync_branch_capture();
DROP TRIGGER IF EXISTS foodsync_branch_capture ON "StockMovement";
CREATE TRIGGER foodsync_branch_capture AFTER INSERT OR UPDATE OR DELETE ON "StockMovement" FOR EACH ROW EXECUTE FUNCTION foodsync_branch_capture();
