-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('ADMIN', 'ADULT', 'CHILD', 'ELDER');

-- CreateEnum
CREATE TYPE "EventCategory" AS ENUM ('MEDICAL', 'SCHOOL', 'GOVERNMENT', 'SOCIAL', 'WORK', 'OTHER');

-- CreateEnum
CREATE TYPE "TxDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('ID_CARD', 'PASSPORT', 'DRIVER_LICENSE', 'VEHICLE_TAX', 'INSURANCE', 'VISA', 'OTHER');

-- CreateEnum
CREATE TYPE "ChoreCadence" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY');

-- CreateEnum
CREATE TYPE "JobKind" AS ENUM ('EVENT', 'BILL', 'DOCUMENT', 'MEDICATION', 'CHORE', 'BUDGET_ALERT', 'BIRTHDAY', 'MONTH_SUMMARY');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'SENT', 'CANCELLED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "JobLane" AS ENUM ('DIGEST', 'URGENT');

-- CreateTable
CREATE TABLE "Family" (
    "id" TEXT NOT NULL,
    "lineGroupId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Bangkok',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Family_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "lineUserId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'ADULT',
    "birthDate" DATE,
    "bloodType" TEXT,
    "allergies" TEXT,
    "conditions" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" "EventCategory" NOT NULL DEFAULT 'OTHER',
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3),
    "allDay" BOOLEAN NOT NULL DEFAULT false,
    "location" TEXT,
    "ownerId" TEXT,
    "rrule" TEXT,
    "note" TEXT,
    "reminderOffsets" INTEGER[] DEFAULT ARRAY[10080, 1440, 120]::INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventAttendee" (
    "eventId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,

    CONSTRAINT "EventAttendee_pkey" PRIMARY KEY ("eventId","memberId")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "TxDirection" NOT NULL DEFAULT 'OUT',

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "direction" "TxDirection" NOT NULL,
    "categoryId" TEXT,
    "paidById" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "receiptFileId" TEXT,
    "billId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TxSplit" (
    "transactionId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "share" INTEGER NOT NULL,

    CONSTRAINT "TxSplit_pkey" PRIMARY KEY ("transactionId","memberId")
);

-- CreateTable
CREATE TABLE "Budget" (
    "familyId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "limitAmount" INTEGER NOT NULL,
    "alertedPercent" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("familyId","categoryId","yearMonth")
);

-- CreateTable
CREATE TABLE "Bill" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "amount" INTEGER,
    "dueDay" INTEGER NOT NULL,
    "autoCreateTx" BOOLEAN NOT NULL DEFAULT true,
    "categoryId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "reminderOffsets" INTEGER[] DEFAULT ARRAY[4320, 1440]::INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL DEFAULT 'OTHER',
    "expiresAt" DATE NOT NULL,
    "ownerId" TEXT,
    "fileId" TEXT,
    "reminderOffsets" INTEGER[] DEFAULT ARRAY[86400, 43200, 10080]::INTEGER[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Medication" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "dosage" TEXT,
    "times" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "escalateAfterMin" INTEGER NOT NULL DEFAULT 45,

    CONSTRAINT "Medication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MedLog" (
    "id" TEXT NOT NULL,
    "medicationId" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "takenAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),

    CONSTRAINT "MedLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chore" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cadence" "ChoreCadence" NOT NULL DEFAULT 'WEEKLY',
    "rotationMemberIds" TEXT[],
    "rotationCursor" INTEGER NOT NULL DEFAULT 0,
    "nextDueAt" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Chore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShoppingItem" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "qty" TEXT,
    "addedById" TEXT,
    "boughtAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShoppingItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationJob" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "kind" "JobKind" NOT NULL,
    "refId" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "lane" "JobLane" NOT NULL DEFAULT 'DIGEST',
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PushBudget" (
    "familyId" TEXT NOT NULL,
    "yearMonth" TEXT NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "lineReported" INTEGER,
    "reconciledAt" TIMESTAMP(3),

    CONSTRAINT "PushBudget_pkey" PRIMARY KEY ("familyId","yearMonth")
);

-- CreateIndex
CREATE UNIQUE INDEX "Family_lineGroupId_key" ON "Family"("lineGroupId");

-- CreateIndex
CREATE INDEX "Member_familyId_idx" ON "Member"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "Member_familyId_lineUserId_key" ON "Member"("familyId", "lineUserId");

-- CreateIndex
CREATE INDEX "Event_familyId_startAt_idx" ON "Event"("familyId", "startAt");

-- CreateIndex
CREATE UNIQUE INDEX "Category_familyId_name_kind_key" ON "Category"("familyId", "name", "kind");

-- CreateIndex
CREATE INDEX "Transaction_familyId_occurredAt_idx" ON "Transaction"("familyId", "occurredAt");

-- CreateIndex
CREATE INDEX "Bill_familyId_idx" ON "Bill"("familyId");

-- CreateIndex
CREATE INDEX "Document_familyId_expiresAt_idx" ON "Document"("familyId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "MedLog_medicationId_scheduledAt_key" ON "MedLog"("medicationId", "scheduledAt");

-- CreateIndex
CREATE INDEX "Chore_familyId_idx" ON "Chore"("familyId");

-- CreateIndex
CREATE INDEX "ShoppingItem_familyId_boughtAt_idx" ON "ShoppingItem"("familyId", "boughtAt");

-- CreateIndex
CREATE INDEX "NotificationJob_status_dueAt_idx" ON "NotificationJob"("status", "dueAt");

-- CreateIndex
CREATE INDEX "NotificationJob_familyId_status_dueAt_idx" ON "NotificationJob"("familyId", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationJob_kind_refId_dueAt_key" ON "NotificationJob"("kind", "refId", "dueAt");

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventAttendee" ADD CONSTRAINT "EventAttendee_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventAttendee" ADD CONSTRAINT "EventAttendee_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TxSplit" ADD CONSTRAINT "TxSplit_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TxSplit" ADD CONSTRAINT "TxSplit_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Medication" ADD CONSTRAINT "Medication_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MedLog" ADD CONSTRAINT "MedLog_medicationId_fkey" FOREIGN KEY ("medicationId") REFERENCES "Medication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chore" ADD CONSTRAINT "Chore_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShoppingItem" ADD CONSTRAINT "ShoppingItem_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShoppingItem" ADD CONSTRAINT "ShoppingItem_addedById_fkey" FOREIGN KEY ("addedById") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationJob" ADD CONSTRAINT "NotificationJob_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PushBudget" ADD CONSTRAINT "PushBudget_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

