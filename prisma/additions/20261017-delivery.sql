ALTER TABLE "CustomerOrder" ADD COLUMN IF NOT EXISTS     "customerId" TEXT,
ADD COLUMN IF NOT EXISTS     "deliveredAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS     "deliveryArea" TEXT,
ADD COLUMN IF NOT EXISTS     "deliveryFailureReason" TEXT,
ADD COLUMN IF NOT EXISTS     "deliveryFee" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS     "deliveryFeeTaxCategory" TEXT NOT NULL DEFAULT 'S',
ADD COLUMN IF NOT EXISTS     "deliveryFeeTaxReason" TEXT,
ADD COLUMN IF NOT EXISTS     "deliveryFeeTaxReasonCode" TEXT,
ADD COLUMN IF NOT EXISTS     "deliveryFeeVatAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS     "deliveryFeeVatRate" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS     "deliveryMinimumOrder" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS     "deliveryPaymentMode" TEXT,
ADD COLUMN IF NOT EXISTS     "deliveryStatus" TEXT,
ADD COLUMN IF NOT EXISTS     "deliveryZoneId" TEXT,
ADD COLUMN IF NOT EXISTS     "deliveryZoneName" TEXT,
ADD COLUMN IF NOT EXISTS     "dispatchedAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS     "intakeRequestHash" TEXT,
ADD COLUMN IF NOT EXISTS     "intakeRequestId" TEXT,
ADD COLUMN IF NOT EXISTS     "riderId" TEXT;

CREATE TABLE IF NOT EXISTS "Customer" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "notes" TEXT,
    "addresses" JSONB NOT NULL DEFAULT '[]',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DeliveryZone" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fee" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "minimumOrder" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "areas" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "etaMinutes" INTEGER NOT NULL DEFAULT 45,
    "feeVatRate" DOUBLE PRECISION,
    "feeTaxCategory" TEXT NOT NULL DEFAULT 'S',
    "feeTaxReasonCode" TEXT,
    "feeTaxReason" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryZone_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Rider" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rider_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DeliveryEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "riderId" TEXT,
    "riderName" TEXT,
    "userId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RiderCashCollection" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "tillPaymentId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "businessDate" TIMESTAMP(3) NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "settlementId" TEXT,

    CONSTRAINT "RiderCashCollection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "RiderSettlement" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "requestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tillSessionId" TEXT NOT NULL,
    "businessDate" TIMESTAMP(3) NOT NULL,
    "expectedCash" DOUBLE PRECISION NOT NULL,
    "countedCash" DOUBLE PRECISION NOT NULL,
    "difference" DOUBLE PRECISION NOT NULL,
    "notes" TEXT,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiderSettlement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Customer_organizationId_phone_key" ON "Customer"("organizationId", "phone");

CREATE INDEX IF NOT EXISTS "DeliveryZone_organizationId_branchId_isActive_idx" ON "DeliveryZone"("organizationId", "branchId", "isActive");

CREATE UNIQUE INDEX IF NOT EXISTS "DeliveryZone_branchId_name_key" ON "DeliveryZone"("branchId", "name");

CREATE INDEX IF NOT EXISTS "Rider_organizationId_branchId_active_idx" ON "Rider"("organizationId", "branchId", "active");

CREATE INDEX IF NOT EXISTS "DeliveryEvent_orderId_createdAt_idx" ON "DeliveryEvent"("orderId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "RiderCashCollection_orderId_key" ON "RiderCashCollection"("orderId");

CREATE UNIQUE INDEX IF NOT EXISTS "RiderCashCollection_tillPaymentId_key" ON "RiderCashCollection"("tillPaymentId");

CREATE INDEX IF NOT EXISTS "RiderCashCollection_organizationId_branchId_businessDate_idx" ON "RiderCashCollection"("organizationId", "branchId", "businessDate");

CREATE INDEX IF NOT EXISTS "RiderCashCollection_riderId_settlementId_idx" ON "RiderCashCollection"("riderId", "settlementId");

CREATE INDEX IF NOT EXISTS "RiderSettlement_organizationId_branchId_businessDate_idx" ON "RiderSettlement"("organizationId", "branchId", "businessDate");

CREATE UNIQUE INDEX IF NOT EXISTS "RiderSettlement_organizationId_requestId_key" ON "RiderSettlement"("organizationId", "requestId");

CREATE UNIQUE INDEX IF NOT EXISTS "RiderSettlement_branchId_number_key" ON "RiderSettlement"("branchId", "number");

CREATE INDEX IF NOT EXISTS "CustomerOrder_branchId_deliveryStatus_idx" ON "CustomerOrder"("branchId", "deliveryStatus");

CREATE UNIQUE INDEX IF NOT EXISTS "CustomerOrder_organizationId_intakeRequestId_key" ON "CustomerOrder"("organizationId", "intakeRequestId");

ALTER TABLE "CustomerOrder" ADD CONSTRAINT "CustomerOrder_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CustomerOrder" ADD CONSTRAINT "CustomerOrder_deliveryZoneId_fkey" FOREIGN KEY ("deliveryZoneId") REFERENCES "DeliveryZone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CustomerOrder" ADD CONSTRAINT "CustomerOrder_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DeliveryZone" ADD CONSTRAINT "DeliveryZone_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Rider" ADD CONSTRAINT "Rider_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DeliveryEvent" ADD CONSTRAINT "DeliveryEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CustomerOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RiderCashCollection" ADD CONSTRAINT "RiderCashCollection_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CustomerOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RiderCashCollection" ADD CONSTRAINT "RiderCashCollection_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RiderCashCollection" ADD CONSTRAINT "RiderCashCollection_tillPaymentId_fkey" FOREIGN KEY ("tillPaymentId") REFERENCES "TillPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RiderCashCollection" ADD CONSTRAINT "RiderCashCollection_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "RiderSettlement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RiderSettlement" ADD CONSTRAINT "RiderSettlement_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "Rider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RiderSettlement" ADD CONSTRAINT "RiderSettlement_tillSessionId_fkey" FOREIGN KEY ("tillSessionId") REFERENCES "TillSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
