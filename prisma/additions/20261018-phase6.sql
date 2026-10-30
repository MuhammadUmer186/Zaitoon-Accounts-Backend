ALTER TYPE "AccountingMappingKey" ADD VALUE 'GIFT_CARD_LIABILITY';

ALTER TYPE "AccountingMappingKey" ADD VALUE 'LOYALTY_LIABILITY';

ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS     "creditLimit" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS     "houseAccountEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS     "houseBalance" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS     "lastVisitAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS     "loyaltyPoints" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS     "totalSpend" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS     "visitCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "CustomerOrder" ADD COLUMN IF NOT EXISTS     "couponCode" TEXT,
ADD COLUMN IF NOT EXISTS     "promotionAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS     "promotions" JSONB;

ALTER TABLE "DailySale" ADD COLUMN IF NOT EXISTS     "giftCardAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS     "houseAccountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS     "loyaltyAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE TABLE "GiftCard" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "customerId" TEXT,
    "initialAmount" DOUBLE PRECISION NOT NULL,
    "balance" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expiresAt" TIMESTAMP(3),
    "issuedBranchId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiftCard_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GiftCardTransaction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "giftCardId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "balanceAfter" DOUBLE PRECISION NOT NULL,
    "orderId" TEXT,
    "receiptId" TEXT,
    "referenceKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftCardTransaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "LoyaltyTransaction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "points" DOUBLE PRECISION NOT NULL,
    "value" DOUBLE PRECISION NOT NULL,
    "balanceAfter" DOUBLE PRECISION NOT NULL,
    "orderId" TEXT,
    "referenceKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyTransaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HouseAccountTransaction" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "balanceAfter" DOUBLE PRECISION NOT NULL,
    "orderId" TEXT,
    "receiptId" TEXT,
    "referenceKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HouseAccountTransaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomerReceipt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "customerId" TEXT,
    "giftCardId" TEXT,
    "tillSessionId" TEXT,
    "userId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "businessDate" TIMESTAMP(3) NOT NULL,
    "journalEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "scope" TEXT NOT NULL DEFAULT 'all',
    "dishIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "categoryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "branchIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "daysOfWeek" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "startTime" TEXT,
    "endTime" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "customerTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "couponCode" TEXT,
    "buyQuantity" INTEGER,
    "getQuantity" INTEGER,
    "minimumSpend" DOUBLE PRECISION,
    "freeDishId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "stackable" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GiftCard_organizationId_code_key" ON "GiftCard"("organizationId", "code");

CREATE UNIQUE INDEX "GiftCardTransaction_referenceKey_key" ON "GiftCardTransaction"("referenceKey");

CREATE INDEX "GiftCardTransaction_organizationId_createdAt_idx" ON "GiftCardTransaction"("organizationId", "createdAt");

CREATE UNIQUE INDEX "LoyaltyTransaction_referenceKey_key" ON "LoyaltyTransaction"("referenceKey");

CREATE INDEX "LoyaltyTransaction_organizationId_createdAt_idx" ON "LoyaltyTransaction"("organizationId", "createdAt");

CREATE UNIQUE INDEX "HouseAccountTransaction_referenceKey_key" ON "HouseAccountTransaction"("referenceKey");

CREATE INDEX "HouseAccountTransaction_customerId_createdAt_idx" ON "HouseAccountTransaction"("customerId", "createdAt");

CREATE INDEX "CustomerReceipt_organizationId_branchId_businessDate_idx" ON "CustomerReceipt"("organizationId", "branchId", "businessDate");

CREATE UNIQUE INDEX "CustomerReceipt_organizationId_requestId_key" ON "CustomerReceipt"("organizationId", "requestId");

CREATE INDEX "Promotion_organizationId_isActive_idx" ON "Promotion"("organizationId", "isActive");

CREATE UNIQUE INDEX "Promotion_organizationId_couponCode_key" ON "Promotion"("organizationId", "couponCode");

ALTER TABLE "GiftCard" ADD CONSTRAINT "GiftCard_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "GiftCardTransaction" ADD CONSTRAINT "GiftCardTransaction_giftCardId_fkey" FOREIGN KEY ("giftCardId") REFERENCES "GiftCard"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HouseAccountTransaction" ADD CONSTRAINT "HouseAccountTransaction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CustomerReceipt" ADD CONSTRAINT "CustomerReceipt_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
