-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "dueMonth" INTEGER,
ADD COLUMN     "estimateAmount" INTEGER,
ADD COLUMN     "everyMonths" INTEGER NOT NULL DEFAULT 1;

