-- Run after db push, before starting the API. Snapshot existing menus once;
-- future catalog price edits must not change saved branch prices.
BEGIN;
INSERT INTO "BranchMenuItem" ("id","organizationId","branchId","dishId","price","isActive","optionPrices","createdAt","updatedAt")
SELECT 'bm_' || md5(b."id" || ':' || d."id"), b."organizationId", b."id", d."id", d."price", d."isActive",
  jsonb_build_object(
    'sizes', COALESCE((SELECT jsonb_object_agg(s."id",s."price") FROM "DishSize" s WHERE s."dishId"=d."id"),'{}'::jsonb),
    'modifiers', COALESCE((SELECT jsonb_object_agg(o."id",o."price") FROM "DishModifierGroup" l JOIN "ModifierOption" o ON o."groupId"=l."groupId" WHERE l."dishId"=d."id"),'{}'::jsonb),
    'combo', COALESCE((SELECT jsonb_object_agg(o."id",o."priceDelta") FROM "ComboGroup" g JOIN "ComboOption" o ON o."groupId"=g."id" WHERE g."dishId"=d."id"),'{}'::jsonb)
  ), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Branch" b JOIN "Dish" d ON d."organizationId"=b."organizationId"
WHERE b."menuInitialized"=FALSE
ON CONFLICT ("branchId","dishId") DO NOTHING;
UPDATE "Branch" SET "menuInitialized"=TRUE WHERE "menuInitialized"=FALSE;
-- Centrally managed branch configuration may be edited even when a PC owns
-- operational writes. It is delivered downward, never replicated upward.
DROP TRIGGER IF EXISTS foodsync_branch_ownership ON "BranchMenuItem";
COMMIT;
