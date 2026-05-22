-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('ACTIVE', 'CANCELLED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "InferenceStatus" AS ENUM ('OK', 'ERROR', 'CANCELLED');

-- CreateTable
CREATE TABLE "Conversation" (
    "id" UUID NOT NULL,
    "title" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inferenceLogId" TEXT,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InferenceLog" (
    "id" TEXT NOT NULL,
    "conversationId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" "InferenceStatus" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3) NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "ttftMs" INTEGER,
    "streamed" BOOLEAN NOT NULL DEFAULT false,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "inputPreview" TEXT NOT NULL,
    "outputPreview" TEXT NOT NULL,
    "output" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "tags" JSONB,
    "sdkVersion" TEXT NOT NULL,
    "raw" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InferenceLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Conversation_status_updatedAt_idx" ON "Conversation"("status", "updatedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "Message_inferenceLogId_key" ON "Message"("inferenceLogId");

-- CreateIndex
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "InferenceLog_conversationId_startedAt_idx" ON "InferenceLog"("conversationId", "startedAt");

-- CreateIndex
CREATE INDEX "InferenceLog_provider_startedAt_idx" ON "InferenceLog"("provider", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "InferenceLog_status_startedAt_idx" ON "InferenceLog"("status", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "InferenceLog_startedAt_idx" ON "InferenceLog"("startedAt" DESC);

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_inferenceLogId_fkey" FOREIGN KEY ("inferenceLogId") REFERENCES "InferenceLog"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InferenceLog" ADD CONSTRAINT "InferenceLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
