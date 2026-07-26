-- CreateEnum
CREATE TYPE "WeightUnit" AS ENUM ('lb', 'kg');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "githubId" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeightEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "measuredOn" DATE NOT NULL,
    "grams" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeightEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeightSettings" (
    "userId" TEXT NOT NULL,
    "unit" "WeightUnit" NOT NULL DEFAULT 'lb',
    "targetRateG" INTEGER NOT NULL DEFAULT 227,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WeightSettings_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_githubId_key" ON "User"("githubId");

-- CreateIndex
CREATE UNIQUE INDEX "WeightEntry_userId_measuredOn_key" ON "WeightEntry"("userId", "measuredOn");

-- AddForeignKey
ALTER TABLE "WeightEntry" ADD CONSTRAINT "WeightEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WeightSettings" ADD CONSTRAINT "WeightSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
