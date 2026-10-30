-- Gateway intents/events are owned by the cloud control plane. Only the
-- branch executes the verified settlement command against its ERP ledger.
DROP TRIGGER IF EXISTS foodsync_branch_ownership ON "PaymentIntent";
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "PaymentIntent";
DROP TRIGGER IF EXISTS foodsync_branch_ownership ON "PaymentEvent";
