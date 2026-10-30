CREATE TABLE IF NOT EXISTS "AuthAttemptBucket" (
  "key" TEXT PRIMARY KEY,
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "expiresAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX IF NOT EXISTS "AuthAttemptBucket_expiresAt_idx" ON "AuthAttemptBucket"("expiresAt");
