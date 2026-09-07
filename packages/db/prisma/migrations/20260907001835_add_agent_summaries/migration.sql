-- CreateEnum
CREATE TYPE "AgentSummaryKind" AS ENUM ('scheduled', 'manual');

-- CreateTable
CREATE TABLE "AgentSummary" (
    "id" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "kind" "AgentSummaryKind" NOT NULL DEFAULT 'scheduled',
    "callCount" INTEGER NOT NULL,
    "totalTokens" INTEGER NOT NULL,
    "errorCount" INTEGER NOT NULL,
    "costMicroUsd" INTEGER NOT NULL,
    "medianPromptTokens" INTEGER NOT NULL,
    "models" JSONB NOT NULL,
    "flags" JSONB NOT NULL,
    "narrative" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentView" (
    "userId" TEXT NOT NULL,
    "lastViewedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentView_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "AgentSummary_periodEnd_idx" ON "AgentSummary"("periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSummary_periodStart_periodEnd_kind_key" ON "AgentSummary"("periodStart", "periodEnd", "kind");

-- AddForeignKey
ALTER TABLE "AgentView" ADD CONSTRAINT "AgentView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

