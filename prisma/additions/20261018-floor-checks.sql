ALTER TABLE "CustomerOrder" ADD COLUMN     "guestCount" INTEGER,
ADD COLUMN     "prebillPrints" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "DiningTable" ADD COLUMN     "guestCount" INTEGER,
ADD COLUMN     "needsClearing" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "seatedAt" TIMESTAMP(3),
ADD COLUMN     "section" TEXT NOT NULL DEFAULT 'Main',
ADD COLUMN     "shape" TEXT NOT NULL DEFAULT 'rectangle',
ADD COLUMN     "x" DOUBLE PRECISION NOT NULL DEFAULT 5,
ADD COLUMN     "y" DOUBLE PRECISION NOT NULL DEFAULT 5;

ALTER TABLE "TillPayment" ADD COLUMN     "checkId" TEXT;

ALTER TABLE "ZatcaDocument" ADD COLUMN     "checkId" TEXT;

CREATE TABLE "OrderCheck" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "itemIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lines" JSONB NOT NULL,
    "itemsTotal" DOUBLE PRECISION NOT NULL,
    "discountAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalAmount" DOUBLE PRECISION NOT NULL,
    "vatRate" DOUBLE PRECISION NOT NULL,
    "vatAmount" DOUBLE PRECISION NOT NULL,
    "foodCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'unpaid',
    "payments" JSONB,
    "paidAt" TIMESTAMP(3),
    "paidBy" TEXT,
    "refundedAt" TIMESTAMP(3),
    "receiptPrints" INTEGER NOT NULL DEFAULT 0,
    "dailySaleId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderCheck_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderCheck_organizationId_branchId_status_idx" ON "OrderCheck"("organizationId", "branchId", "status");

CREATE INDEX "OrderCheck_dailySaleId_idx" ON "OrderCheck"("dailySaleId");

CREATE UNIQUE INDEX "OrderCheck_orderId_number_key" ON "OrderCheck"("orderId", "number");

ALTER TABLE "OrderCheck" ADD CONSTRAINT "OrderCheck_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CustomerOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderCheck" ADD CONSTRAINT "OrderCheck_dailySaleId_fkey" FOREIGN KEY ("dailySaleId") REFERENCES "DailySale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ZatcaDocument" ADD CONSTRAINT "ZatcaDocument_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "OrderCheck"("id") ON DELETE SET NULL ON UPDATE CASCADE;