ALTER TABLE "BranchRuntime" ADD COLUMN IF NOT EXISTS "configurationError" TEXT;
ALTER TABLE "BranchRuntime" ADD COLUMN IF NOT EXISTS "configurationHash" TEXT;
ALTER TABLE "BranchRuntime" ADD COLUMN IF NOT EXISTS "configurationSyncedAt" TIMESTAMP(3);
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "provisionedBy" TEXT;
-- Additive ownership fence; token revocation NEVER releases write ownership.
ALTER TABLE "BranchSyncNode" ADD COLUMN IF NOT EXISTS "ownsWrites" BOOLEAN NOT NULL DEFAULT TRUE;
CREATE OR REPLACE FUNCTION foodsync_parent_branch(table_name TEXT, data JSONB) RETURNS TEXT AS $$
DECLARE parent_table TEXT; parent_field TEXT; parent_row JSONB;
BEGIN
 IF data IS NULL THEN RETURN NULL; END IF;
 IF table_name='Branch' THEN RETURN data->>'id'; END IF;
 IF data ? 'branchId' THEN RETURN data->>'branchId'; END IF;
 CASE table_name
 WHEN 'JournalLine' THEN parent_table:='JournalEntry'; parent_field:='journalEntryId';
 WHEN 'CustomerOrderItem' THEN parent_table:='CustomerOrder'; parent_field:='orderId';
 WHEN 'BillItem' THEN parent_table:='Bill'; parent_field:='billId';
 WHEN 'DeliveryBreakdown' THEN parent_table:='DailySale'; parent_field:='dailySaleId';
 WHEN 'WastageItem' THEN parent_table:='WastageReport'; parent_field:='wastageReportId';
 WHEN 'PurchaseOrderItem' THEN parent_table:='PurchaseOrder'; parent_field:='purchaseOrderId';
 WHEN 'TillMovement' THEN parent_table:='TillSession'; parent_field:='sessionId';
 WHEN 'DeliveryEvent' THEN parent_table:='CustomerOrder'; parent_field:='orderId';
 WHEN 'HrPayrollLine' THEN parent_table:='HrPayrollRun'; parent_field:='runId';
 WHEN 'HrPayrollPayment' THEN parent_table:='HrPayrollLine'; parent_field:='lineId';
 WHEN 'PaymentEvent' THEN parent_table:='PaymentIntent'; parent_field:='intentId';
 WHEN 'OfflineOrderSync' THEN parent_table:='PosOfflineDevice'; parent_field:='deviceId';
 ELSE RETURN NULL;
 END CASE;
 EXECUTE format('SELECT to_jsonb(t) FROM %I t WHERE "id"=$1',parent_table) INTO parent_row USING data->>parent_field;
 RETURN foodsync_parent_branch(parent_table,parent_row);
END; $$ LANGUAGE plpgsql;
CREATE OR REPLACE FUNCTION foodsync_branch_ownership_guard() RETURNS trigger AS $$
DECLARE previous_branch TEXT; next_branch TEXT; target_branch TEXT; runtime "BranchRuntime";
BEGIN
 -- Branch metadata is centrally managed. Its stable identity and deletion
 -- remain fenced, while VAT/name/address updates can propagate downward.
 IF TG_TABLE_NAME='Branch' AND TG_OP='UPDATE' AND to_jsonb(OLD)->>'id'=to_jsonb(NEW)->>'id' AND to_jsonb(OLD)->>'organizationId'=to_jsonb(NEW)->>'organizationId' THEN RETURN NEW; END IF;
 IF TG_OP <> 'INSERT' THEN previous_branch:=foodsync_parent_branch(TG_TABLE_NAME,to_jsonb(OLD)); END IF;
 IF TG_OP <> 'DELETE' THEN next_branch:=foodsync_parent_branch(TG_TABLE_NAME,to_jsonb(NEW)); END IF;
 FOR target_branch IN SELECT DISTINCT value FROM unnest(ARRAY[previous_branch,next_branch]) value WHERE value IS NOT NULL ORDER BY value LOOP
  -- Enrollment takes the same lock. Earlier writes finish before enrollment;
  -- later writes observe ownership and roll back with all their side effects.
  PERFORM pg_advisory_xact_lock(hashtext('branch-owner:'||target_branch));
  SELECT * INTO runtime FROM "BranchRuntime" WHERE "id"='local';
  IF FOUND THEN
   IF runtime."branchId" <> target_branch THEN RAISE EXCEPTION 'FOODSYNC_BRANCH_OWNERSHIP'; END IF;
  ELSIF EXISTS(SELECT 1 FROM "BranchSyncNode" WHERE "id"=current_setting('foodsync.replica_node',TRUE) AND "branchId"=target_branch AND "ownsWrites"=TRUE AND "isActive"=TRUE) THEN
   -- Transaction-local reconciliation is performed only after receiver authentication.
   NULL;
  ELSIF EXISTS(SELECT 1 FROM "BranchSyncNode" WHERE "branchId"=target_branch AND "ownsWrites"=TRUE) THEN
   RAISE EXCEPTION 'FOODSYNC_BRANCH_OWNERSHIP';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$ LANGUAGE plpgsql;
DO $$ DECLARE item RECORD; BEGIN
 FOR item IN
  SELECT DISTINCT table_name FROM information_schema.columns
  WHERE table_schema=current_schema() AND column_name='branchId'
   -- Control-plane tables carry branchId for routing only; the cloud must be
   -- able to queue work for a branch it does not own (see 20261027 repair).
   AND table_name NOT IN ('KitchenPrintJob','BranchRuntime','BranchOutbox','BranchSyncNode','BranchSyncProjection','BranchRemoteCommand','BranchWalletReservation','BranchWalletReceipt','BranchTransferReceipt','UserBranchAccess','BranchTarget','AuditLog','PaymentIntent','FreeDishQr','FreeDishSubmission')
  UNION SELECT name FROM unnest(ARRAY['Branch','JournalLine','CustomerOrderItem','BillItem','DeliveryBreakdown','WastageItem','PurchaseOrderItem','TillMovement','DeliveryEvent','HrPayrollLine','HrPayrollPayment','OfflineOrderSync']) name
 LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS foodsync_branch_ownership ON %I',item.table_name);
  EXECUTE format('CREATE TRIGGER foodsync_branch_ownership BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION foodsync_branch_ownership_guard()',item.table_name);
 END LOOP;
END $$;
