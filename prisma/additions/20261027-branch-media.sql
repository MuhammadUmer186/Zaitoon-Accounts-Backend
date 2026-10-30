-- Documents carry portable content references during transport. Files are
-- authenticated on the receiving host before the matching rows commit.
DROP TRIGGER IF EXISTS foodsync_replica_revision ON "Document";
CREATE TRIGGER foodsync_replica_revision AFTER INSERT OR UPDATE OR DELETE ON "Document"
FOR EACH ROW EXECUTE FUNCTION foodsync_replica_revision();
