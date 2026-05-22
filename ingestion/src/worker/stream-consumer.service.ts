import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import type Redis from "ioredis";
import { ConversationStatus, InferenceStatus, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { REDIS } from "../common/redis.provider";
import { INFERENCE_CONSUMER, INFERENCE_GROUP, INFERENCE_STREAM } from "../common/stream.constants";
import { redactText } from "../common/redact";
import type { InferenceLogDto } from "../ingest/ingest.dto";

/**
 * Background consumer. Reads from the Redis Stream's consumer group, persists
 * each event to Postgres, and acks. Failed inserts go to the pending-entries
 * list (PEL) and will be retried via XAUTOCLAIM on the next idle scan.
 *
 * One process can run multiple worker replicas safely — Redis Streams' group
 * semantics dispatch each event to exactly one consumer.
 */
@Injectable()
export class StreamConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(StreamConsumerService.name);
  private running = false;
  private redactEnabled = true;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit() {
    this.redactEnabled = (process.env.PII_REDACTION ?? "true") !== "false";
    await this.ensureGroup();
    this.running = true;
    void this.runLoop();
    void this.claimLoop();
  }

  async onModuleDestroy() {
    this.running = false;
  }

  private async ensureGroup() {
    try {
      await this.redis.xgroup("CREATE", INFERENCE_STREAM, INFERENCE_GROUP, "$", "MKSTREAM");
      this.log.log(`created consumer group ${INFERENCE_GROUP} on ${INFERENCE_STREAM}`);
    } catch (err) {
      if ((err as Error).message.includes("BUSYGROUP")) return;
      throw err;
    }
  }

  private async runLoop() {
    this.log.log(`consumer ${INFERENCE_CONSUMER} started`);
    while (this.running) {
      try {
        // XREADGROUP — block up to 5s waiting for new events.
        const res = (await this.redis.xreadgroup(
          "GROUP",
          INFERENCE_GROUP,
          INFERENCE_CONSUMER,
          "COUNT",
          50,
          "BLOCK",
          5000,
          "STREAMS",
          INFERENCE_STREAM,
          ">",
        )) as Array<[string, Array<[string, string[]]>]> | null;

        if (!res) continue;

        for (const [, entries] of res) {
          for (const [id, fields] of entries) {
            await this.handle(id, fields);
          }
        }
      } catch (err) {
        if (!this.running) break;
        this.log.error(`xreadgroup loop error: ${(err as Error).message}`);
        await sleep(500);
      }
    }
  }

  /**
   * Periodically reclaim entries that another consumer started but didn't
   * ack within 30s — covers the case where a worker crashes mid-insert.
   */
  private async claimLoop() {
    while (this.running) {
      try {
        await sleep(15_000);
        const res = (await this.redis.xautoclaim(
          INFERENCE_STREAM,
          INFERENCE_GROUP,
          INFERENCE_CONSUMER,
          30_000,
          "0",
          "COUNT",
          50,
        )) as [string, Array<[string, string[]]>, string[]] | null;
        if (!res) continue;
        const [, entries] = res;
        for (const [id, fields] of entries) {
          this.log.warn(`reclaiming stale entry ${id}`);
          await this.handle(id, fields);
        }
      } catch (err) {
        if (!this.running) break;
        this.log.error(`xautoclaim loop error: ${(err as Error).message}`);
      }
    }
  }

  private async handle(streamId: string, fields: string[]) {
    const payloadIdx = fields.indexOf("payload");
    if (payloadIdx < 0) {
      await this.ack(streamId);
      return;
    }
    let event: InferenceLogDto;
    try {
      event = JSON.parse(fields[payloadIdx + 1]) as InferenceLogDto;
    } catch (err) {
      this.log.warn(`drop unparseable event ${streamId}: ${(err as Error).message}`);
      await this.ack(streamId);
      return;
    }

    try {
      await this.persist(event);
      await this.ack(streamId);
    } catch (err) {
      this.log.error(
        `persist failed for req=${event.requestId} streamId=${streamId}: ${(err as Error).message}`,
      );
      // Don't ack — XAUTOCLAIM will pick it up after the idle timeout.
    }
  }

  private async persist(event: InferenceLogDto) {
    // Make sure the parent Conversation row exists. The chatbot creates it
    // up-front via /conversations, but a log from an unknown conversation
    // shouldn't be dropped — we create a stub so the row is still queryable.
    await this.prisma.conversation.upsert({
      where: { id: event.conversationId },
      update: { updatedAt: new Date() },
      create: {
        id: event.conversationId,
        provider: event.provider,
        model: event.model,
        status: ConversationStatus.ACTIVE,
      },
    });

    const data: Prisma.InferenceLogUncheckedCreateInput = {
      id: event.requestId,
      conversationId: event.conversationId,
      provider: event.provider,
      model: event.model,
      status: mapStatus(event.status),
      startedAt: new Date(event.startedAt),
      finishedAt: new Date(event.finishedAt),
      latencyMs: event.latencyMs,
      ttftMs: event.ttftMs ?? null,
      streamed: event.streamed,
      promptTokens: event.usage.promptTokens,
      completionTokens: event.usage.completionTokens,
      totalTokens: event.usage.totalTokens,
      inputPreview: redactText(event.inputPreview, this.redactEnabled),
      outputPreview: redactText(event.outputPreview, this.redactEnabled),
      output: redactText(event.output ?? null, this.redactEnabled),
      errorCode: event.errorCode ?? null,
      errorMessage: event.errorMessage ?? null,
      tags: event.tags ? (event.tags as Prisma.InputJsonValue) : Prisma.JsonNull,
      sdkVersion: event.sdkVersion,
      raw: event as unknown as Prisma.InputJsonValue,
    };

    // Idempotent: same requestId from a retry is a no-op.
    await this.prisma.inferenceLog.upsert({
      where: { id: event.requestId },
      update: {}, // never overwrite a previous record
      create: data,
    });

    // Backfill the message ↔ log link. The chatbot persists the assistant
    // message as soon as the stream closes, before this row exists. We
    // attach to the most-recent unlinked ASSISTANT message in this convo.
    // Safe under concurrency thanks to the @unique constraint on inferenceLogId.
    const candidate = await this.prisma.message.findFirst({
      where: {
        conversationId: event.conversationId,
        role: "ASSISTANT",
        inferenceLogId: null,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (candidate) {
      await this.prisma.message
        .update({
          where: { id: candidate.id },
          data: { inferenceLogId: event.requestId },
        })
        .catch((err) => {
          // P2002 = unique violation: another worker already linked. Benign.
          if ((err as { code?: string }).code !== "P2002") throw err;
        });
    }
  }

  private async ack(streamId: string) {
    try {
      await this.redis.xack(INFERENCE_STREAM, INFERENCE_GROUP, streamId);
    } catch (err) {
      this.log.warn(`xack failed for ${streamId}: ${(err as Error).message}`);
    }
  }
}

function mapStatus(s: string): InferenceStatus {
  switch (s) {
    case "ok":
      return InferenceStatus.OK;
    case "error":
      return InferenceStatus.ERROR;
    case "cancelled":
      return InferenceStatus.CANCELLED;
    default:
      return InferenceStatus.ERROR;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
