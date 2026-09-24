-- AlterTable
ALTER TABLE "Family" ADD COLUMN     "calendarToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Family_calendarToken_key" ON "Family"("calendarToken");

