-- CreateEnum
CREATE TYPE "BillFrequency" AS ENUM ('ONCE', 'DAILY', 'WEEKLY', 'MONTHLY');

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "billDueOn" DATE;

-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "direction" "TxDirection" NOT NULL DEFAULT 'OUT',
ADD COLUMN     "endsOn" DATE,
ADD COLUMN     "frequency" "BillFrequency" NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN     "interval" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "startsOn" DATE;

-- CreateTable
CREATE TABLE "BillAmount" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "amount" INTEGER NOT NULL,

    CONSTRAINT "BillAmount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReserveEntry" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "transactionId" TEXT,

    CONSTRAINT "ReserveEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillAmount_billId_effectiveFrom_key" ON "BillAmount"("billId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "ReserveEntry_transactionId_key" ON "ReserveEntry"("transactionId");

-- CreateIndex
CREATE INDEX "ReserveEntry_familyId_idx" ON "ReserveEntry"("familyId");

-- CreateIndex
CREATE INDEX "ReserveEntry_billId_idx" ON "ReserveEntry"("billId");

-- AddForeignKey
ALTER TABLE "BillAmount" ADD CONSTRAINT "BillAmount_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReserveEntry" ADD CONSTRAINT "ReserveEntry_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReserveEntry" ADD CONSTRAINT "ReserveEntry_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReserveEntry" ADD CONSTRAINT "ReserveEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

