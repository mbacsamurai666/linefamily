-- CreateTable
CREATE TABLE "DigestImage" (
    "id" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "png" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DigestImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DigestImage_createdAt_idx" ON "DigestImage"("createdAt");

-- AddForeignKey
ALTER TABLE "DigestImage" ADD CONSTRAINT "DigestImage_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE CASCADE ON UPDATE CASCADE;

