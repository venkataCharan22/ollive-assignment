/* eslint-disable no-console */
import { PrismaClient, ConversationStatus, MessageRole, InferenceStatus } from "@prisma/client";
import { randomUUID } from "node:crypto";

/**
 * Seed a handful of conversations + inference logs so the dashboard has
 * something to render the first time you open it. Safe to re-run; it always
 * clears the existing demo rows first (rows tagged with demo=true).
 */
const prisma = new PrismaClient();

async function main() {
  console.log("Clearing previous demo rows…");
  await prisma.inferenceLog.deleteMany({ where: { tags: { path: ["demo"], equals: "true" } } });
  await prisma.message.deleteMany({});
  await prisma.conversation.deleteMany({});

  const providers: Array<{ provider: "openai" | "anthropic" | "google" | "mock"; model: string }> = [
    { provider: "openai", model: "gpt-4o-mini" },
    { provider: "anthropic", model: "claude-3-5-sonnet-latest" },
    { provider: "google", model: "gemini-1.5-flash" },
    { provider: "mock", model: "mock-fast" },
  ];

  for (let c = 0; c < 4; c += 1) {
    const cfg = providers[c % providers.length];
    const convo = await prisma.conversation.create({
      data: {
        title: `Demo conversation ${c + 1}`,
        provider: cfg.provider,
        model: cfg.model,
        status: c === 3 ? ConversationStatus.ARCHIVED : ConversationStatus.ACTIVE,
      },
    });

    for (let i = 0; i < 8; i += 1) {
      const isUser = i % 2 === 0;
      const userMsg = "What's the capital of France?";
      const assistantMsg = "Paris is the capital of France, on the Seine.";
      const role = isUser ? MessageRole.USER : MessageRole.ASSISTANT;
      const content = isUser ? userMsg : assistantMsg;

      let inferenceLogId: string | undefined;
      if (!isUser) {
        const start = new Date(Date.now() - (8 - i) * 60 * 1000);
        const latency = 200 + Math.round(Math.random() * 800);
        const finish = new Date(start.getTime() + latency);
        const promptTokens = 20 + Math.floor(Math.random() * 40);
        const completionTokens = 30 + Math.floor(Math.random() * 60);
        const failed = Math.random() < 0.08;
        const log = await prisma.inferenceLog.create({
          data: {
            id: randomUUID(),
            conversationId: convo.id,
            provider: cfg.provider,
            model: cfg.model,
            status: failed ? InferenceStatus.ERROR : InferenceStatus.OK,
            startedAt: start,
            finishedAt: finish,
            latencyMs: latency,
            ttftMs: Math.round(latency * 0.25),
            streamed: true,
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            inputPreview: userMsg,
            outputPreview: failed ? "" : assistantMsg,
            output: failed ? null : assistantMsg,
            errorCode: failed ? "upstream_5xx" : null,
            errorMessage: failed ? "Provider returned 503" : null,
            tags: { demo: "true" },
            sdkVersion: "0.1.0",
            raw: { seed: true },
          },
        });
        inferenceLogId = log.id;
      }

      await prisma.message.create({
        data: {
          conversationId: convo.id,
          role,
          content,
          inferenceLogId,
        },
      });
    }
    console.log(`  → seeded conversation ${convo.id} (${cfg.provider})`);
  }
  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
