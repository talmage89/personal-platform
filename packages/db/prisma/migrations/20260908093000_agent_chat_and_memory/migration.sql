-- CreateEnum
CREATE TYPE "AgentChatRole" AS ENUM ('user', 'assistant');

-- CreateTable
CREATE TABLE "AgentChat" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "pendingSince" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentChat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentChatMessage" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "role" "AgentChatRole" NOT NULL,
    "body" TEXT NOT NULL,
    "investigation" JSONB,
    "costMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentNote" (
    "key" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sourceChatId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentNote_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "AgentChat_userId_updatedAt_idx" ON "AgentChat"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "AgentChatMessage_chatId_createdAt_idx" ON "AgentChatMessage"("chatId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentNote_updatedAt_idx" ON "AgentNote"("updatedAt");

-- AddForeignKey
ALTER TABLE "AgentChat" ADD CONSTRAINT "AgentChat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentChatMessage" ADD CONSTRAINT "AgentChatMessage_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "AgentChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
