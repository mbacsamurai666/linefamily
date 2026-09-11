-- CreateEnum
CREATE TYPE "AssetCategory" AS ENUM ('PROPERTY', 'VEHICLE', 'ELECTRONICS', 'JEWELRY', 'INVESTMENT', 'OTHER');

-- AlterEnum
ALTER TYPE "JobKind" ADD VALUE 'LOAN_DUE';

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "borrowerName" TEXT NOT NULL,
    "principalSatang" INTEGER NOT NULL,
    "repaidSatang" INTEGER NOT NULL DEFAULT 0,
    "lentAt" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3),
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "reminderOffsets" INTEGER[] DEFAULT ARRAY[1440]::INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "AssetCategory" NOT NULL DEFAULT 'OTHER',
    "valueSatang" INTEGER NOT NULL,
    "acquiredAt" DATE,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deposit" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "balanceSatang" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Loan_familyId_idx" ON "Loan"("familyId");

-- CreateIndex
CREATE INDEX "Asset_familyId_idx" ON "Asset"("familyId");

-- CreateIndex
CREATE INDEX "Deposit_familyId_idx" ON "Deposit"("familyId");

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;
