-- Additive upgrade only. No historical timing or recipes can be reconstructed
-- reliably, so older lines intentionally retain NULL measurement fields.
ALTER TABLE "CustomerOrderItem"
  ADD COLUMN IF NOT EXISTS "recipeUsage" JSONB,
  ADD COLUMN IF NOT EXISTS "preparingAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "readyAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "servedAt" TIMESTAMP(3);
