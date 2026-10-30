-- Additive and repeatable. Apply after 20261026-branch-ownership.sql and
-- 20261026-branch-replica.sql.

-- 1. Control-plane tables are never business data. Databases that applied the
--    earlier ownership script have a guard on BranchRemoteCommand, which made
--    the cloud unable to queue online orders for an owned branch.
DO $$ DECLARE item TEXT; BEGIN
 FOREACH item IN ARRAY ARRAY['BranchRuntime','BranchOutbox','BranchSyncNode','BranchSyncEvent','BranchSyncProjection','BranchReplicaSession','BranchReplicaPart','BranchRemoteCommand'] LOOP
  IF to_regclass(format('%I',item)) IS NOT NULL THEN
   EXECUTE format('DROP TRIGGER IF EXISTS foodsync_branch_ownership ON %I',item);
   EXECUTE format('DROP TRIGGER IF EXISTS foodsync_replica_revision ON %I',item);
  END IF;
 END LOOP;
END $$;

-- 2. Replica acknowledgment chain. A PC restored from an older backup cannot
--    continue the cloud history because its last acknowledged checkpoint no
--    longer matches the cloud's.
ALTER TABLE "BranchRuntime" ADD COLUMN IF NOT EXISTS "lastReplicaDigest" TEXT;
ALTER TABLE "BranchRuntime" ADD COLUMN IF NOT EXISTS "replicaChainError" TEXT;
-- Written in the PC database after the snapshot is read and before upload, so
-- any backup holding it also holds that checkpoint's data (lost-ack recovery).
ALTER TABLE "BranchRuntime" ADD COLUMN IF NOT EXISTS "pendingReplicaRevision" BIGINT;
ALTER TABLE "BranchRuntime" ADD COLUMN IF NOT EXISTS "pendingReplicaDigest" TEXT;
ALTER TABLE "BranchReplicaSession" ADD COLUMN IF NOT EXISTS "baseRevision" BIGINT;
ALTER TABLE "BranchReplicaSession" ADD COLUMN IF NOT EXISTS "baseDigest" TEXT;
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "replicaDigest" TEXT;

-- 3. Command lifecycle: a claimed command whose result never arrived is
--    "unknown", never "failed"; attempts bound retries of a poisoned command.
ALTER TABLE "BranchRemoteCommand" ADD COLUMN IF NOT EXISTS "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BranchRemoteCommand" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "BranchRemoteCommand_status_createdAt_idx" ON "BranchRemoteCommand"("status","createdAt");

-- 4. Per-PC number series (also created by pre-push.sql before db push).
ALTER TABLE "BranchRuntime" ADD COLUMN IF NOT EXISTS "numberSeries" TEXT;
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "numberSeries" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "BranchSyncNode_organizationId_numberSeries_key" ON "BranchSyncNode"("organizationId", "numberSeries");

-- 5. Incremental ERP checkpoints. Every revision increment writes exactly one
--    change-log row in the same transaction, so a delta covering (base, R]
--    must contain exactly R - base rows; otherwise the PC sends a full one.
CREATE TABLE IF NOT EXISTS "BranchChangeLog" ("revision" BIGINT PRIMARY KEY, "entity" TEXT NOT NULL, "entityId" TEXT NOT NULL);
ALTER TABLE "BranchReplicaSession" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'full';
ALTER TABLE "BranchRuntime" ADD COLUMN IF NOT EXISTS "replicaError" TEXT;
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "replicaError" TEXT;
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "replicaErrorAt" TIMESTAMP(3);
CREATE OR REPLACE FUNCTION foodsync_replica_revision() RETURNS trigger AS $$
DECLARE branch TEXT; runtime "BranchRuntime"; row_data JSONB; next_revision BIGINT;
BEGIN
 SELECT * INTO runtime FROM "BranchRuntime" WHERE "id"='local';
 IF NOT FOUND THEN RETURN NULL; END IF;
 row_data:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 branch:=foodsync_parent_branch(TG_TABLE_NAME,row_data);
 IF branch=runtime."branchId" THEN
  UPDATE "BranchRuntime" SET "dataRevision"="dataRevision"+1 WHERE "id"='local' RETURNING "dataRevision" INTO next_revision;
  INSERT INTO "BranchChangeLog"("revision","entity","entityId") VALUES (next_revision,TG_TABLE_NAME,row_data->>'id');
 END IF;
 RETURN NULL;
END; $$ LANGUAGE plpgsql;

-- 6. Branch health reports and alert notification state (cloud).
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "healthReport" JSONB;
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "healthReportedAt" TIMESTAMP(3);
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "alertsNotified" TEXT;

-- 7. Ownership handover. A PC that has handed over (or been released after a
--    disaster) refuses every business write in the database itself, so it can
--    never become a second writer for the branch.
ALTER TABLE "BranchRuntime" ADD COLUMN IF NOT EXISTS "writesFrozen" TEXT;
ALTER TABLE "BranchRuntime" ADD COLUMN IF NOT EXISTS "handoverState" TEXT;
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "handoverRequestedAt" TIMESTAMP(3);
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "releasedAt" TIMESTAMP(3);
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "releasedBy" TEXT;
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "releaseReason" TEXT;
CREATE OR REPLACE FUNCTION foodsync_branch_ownership_guard() RETURNS trigger AS $$
DECLARE previous_branch TEXT; next_branch TEXT; target_branch TEXT; runtime "BranchRuntime";
BEGIN
 -- Branch metadata is centrally managed. Its stable identity and deletion
 -- remain fenced, while VAT/name/address updates can propagate downward.
 IF TG_TABLE_NAME='Branch' AND TG_OP='UPDATE' AND to_jsonb(OLD)->>'id'=to_jsonb(NEW)->>'id' AND to_jsonb(OLD)->>'organizationId'=to_jsonb(NEW)->>'organizationId' THEN RETURN NEW; END IF;
 IF TG_OP <> 'INSERT' THEN previous_branch:=foodsync_parent_branch(TG_TABLE_NAME,to_jsonb(OLD)); END IF;
 IF TG_OP <> 'DELETE' THEN next_branch:=foodsync_parent_branch(TG_TABLE_NAME,to_jsonb(NEW)); END IF;
 FOR target_branch IN SELECT DISTINCT value FROM unnest(ARRAY[previous_branch,next_branch]) value WHERE value IS NOT NULL ORDER BY value LOOP
  PERFORM pg_advisory_xact_lock(hashtext('branch-owner:'||target_branch));
  SELECT * INTO runtime FROM "BranchRuntime" WHERE "id"='local';
  IF FOUND THEN
   IF runtime."branchId" <> target_branch THEN RAISE EXCEPTION 'FOODSYNC_BRANCH_OWNERSHIP'; END IF;
   IF runtime."writesFrozen" IS NOT NULL THEN RAISE EXCEPTION 'FOODSYNC_BRANCH_FROZEN'; END IF;
  ELSIF EXISTS(SELECT 1 FROM "BranchSyncNode" WHERE "id"=current_setting('foodsync.replica_node',TRUE) AND "branchId"=target_branch AND "ownsWrites"=TRUE AND "isActive"=TRUE) THEN
   NULL;
  ELSIF EXISTS(SELECT 1 FROM "BranchSyncNode" WHERE "branchId"=target_branch AND "ownsWrites"=TRUE) THEN
   RAISE EXCEPTION 'FOODSYNC_BRANCH_OWNERSHIP';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$ LANGUAGE plpgsql;

-- 8. ZATCA devices and invoices signed on a branch PC replicate to the cloud.
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "ZatcaDevice";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "ZatcaDevice" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "ZatcaDocument";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "ZatcaDocument" FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
