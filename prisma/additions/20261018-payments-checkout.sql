ALTER TABLE "CommerceSettings" ADD COLUMN IF NOT EXISTS "paymentAdapter" TEXT NOT NULL DEFAULT 'none';

CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "checkId" TEXT,
    "channel" TEXT NOT NULL,
    "adapter" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'created',
    "providerRef" TEXT,
    "settledAt" TIMESTAMP(3),
    "refundStatus" TEXT NOT NULL DEFAULT 'none',
    "refundedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "refundRef" TEXT,
    "failureReason" TEXT,
    "accessTokenHash" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "createdBy" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "intentId" TEXT,
    "adapter" TEXT NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "signatureValid" BOOLEAN NOT NULL,
    "outcome" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CheckoutDevice" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "showOrderId" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckoutDevice_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PaymentIntent_orderId_idx" ON "PaymentIntent"("orderId");

CREATE INDEX "PaymentIntent_organizationId_status_idx" ON "PaymentIntent"("organizationId", "status");

CREATE UNIQUE INDEX "PaymentIntent_organizationId_idempotencyKey_key" ON "PaymentIntent"("organizationId", "idempotencyKey");

CREATE UNIQUE INDEX "PaymentIntent_adapter_providerRef_key" ON "PaymentIntent"("adapter", "providerRef");

CREATE INDEX "PaymentEvent_intentId_idx" ON "PaymentEvent"("intentId");

CREATE UNIQUE INDEX "PaymentEvent_adapter_providerEventId_key" ON "PaymentEvent"("adapter", "providerEventId");

CREATE UNIQUE INDEX "CheckoutDevice_tokenHash_key" ON "CheckoutDevice"("tokenHash");

CREATE INDEX "CheckoutDevice_organizationId_branchId_idx" ON "CheckoutDevice"("organizationId", "branchId");

ALTER TABLE "PaymentEvent" ADD CONSTRAINT "PaymentEvent_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
