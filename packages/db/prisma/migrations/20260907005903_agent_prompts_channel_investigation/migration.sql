-- CreateEnum
CREATE TYPE "AgentPromptKind" AS ENUM ('hourly', 'recap');

-- AlterTable
ALTER TABLE "AgentSummary" ADD COLUMN     "alerts" JSONB,
ADD COLUMN     "investigation" JSONB,
ADD COLUMN     "narrationMicroUsd" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "AgentChannel" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "lastSendAt" TIMESTAMP(3),
    "intervalMinutes" INTEGER NOT NULL DEFAULT 60,
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPrompt" (
    "kind" "AgentPromptKind" NOT NULL,
    "body" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPrompt_pkey" PRIMARY KEY ("kind")
);

