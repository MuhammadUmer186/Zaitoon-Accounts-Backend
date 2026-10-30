ALTER TABLE "OrderCheck" ADD COLUMN     "amountTendered" DOUBLE PRECISION,
ADD COLUMN     "changeAmount" DOUBLE PRECISION;

CREATE TABLE "CommerceSettings" (
    "organizationId" TEXT NOT NULL,
    "loyaltyEarnPerUnit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "loyaltyPointValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "promotionsStack" BOOLEAN NOT NULL DEFAULT false,
    "providerName" TEXT NOT NULL DEFAULT '',
    "paymentEnvironment" TEXT NOT NULL DEFAULT 'sandbox',
    "merchantId" TEXT NOT NULL DEFAULT '',
    "publicKey" TEXT NOT NULL DEFAULT '',
    "secretSealed" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "CommerceSettings_pkey" PRIMARY KEY ("organizationId")
);