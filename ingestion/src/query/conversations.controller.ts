import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ConversationStatus, MessageRole } from "@prisma/client";
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { Type } from "class-transformer";
import { PrismaService } from "../prisma/prisma.service";

class CreateConversationDto {
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsString() @IsIn(["openai", "anthropic", "google", "groq", "mock"]) provider!: string;
  @IsString() @MaxLength(120) model!: string;
}

class UpdateConversationDto {
  @IsOptional() @IsString() @MaxLength(120) title?: string;
  @IsOptional() @IsIn(["ACTIVE", "CANCELLED", "ARCHIVED"]) status?: ConversationStatus;
  @IsOptional() @IsString() provider?: string;
  @IsOptional() @IsString() model?: string;
}

class AppendMessageDto {
  @IsIn(["USER", "ASSISTANT", "SYSTEM"]) role!: MessageRole;
  @IsString() @MaxLength(20_000) content!: string;
  @IsOptional() @IsString() inferenceLogId?: string;
}

class ListQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number = 50;
  @IsOptional() @IsString() cursor?: string; // updatedAt ISO
  @IsOptional() @IsIn(["ACTIVE", "CANCELLED", "ARCHIVED"]) status?: ConversationStatus;
}

/**
 * Conversation CRUD for the chatbot frontend. Lives in the ingestion service
 * because it's the same data store — colocating reads and writes avoids a
 * second app and a second deployment. In a larger system you'd split this
 * out behind a BFF.
 */
@Controller("conversations")
export class ConversationsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  async create(@Body() body: CreateConversationDto) {
    return this.prisma.conversation.create({
      data: {
        title: body.title,
        provider: body.provider,
        model: body.model,
      },
    });
  }

  @Get()
  async list(@Query() q: ListQueryDto) {
    const limit = q.limit ?? 50;
    return this.prisma.conversation.findMany({
      where: {
        ...(q.status ? { status: q.status } : {}),
        ...(q.cursor ? { updatedAt: { lt: new Date(q.cursor) } } : {}),
      },
      orderBy: { updatedAt: "desc" },
      take: limit,
      select: {
        id: true,
        title: true,
        provider: true,
        model: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { messages: true } },
      },
    });
  }

  @Get(":id")
  async get(@Param("id", new ParseUUIDPipe()) id: string) {
    const convo = await this.prisma.conversation.findUnique({
      where: { id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!convo) throw new NotFoundException();

    // Loose join. Two-stage:
    //
    //   1. Prefer the direct FK-like link set by the worker (Message.inferenceLogId).
    //   2. For any ASSISTANT message without a direct link, fall back to a
    //      time-nearest match against the conversation's unclaimed logs.
    //
    // Why the fallback exists: on Vercel/serverless, the SDK's log POST and
    // the chatbot's appendMessage POST race. If the log arrives first, the
    // worker's backfill finds no message to link, no-op. The message lands
    // afterward and stays unlinked. This read-side stitching covers that
    // case without coupling the write path to in-order arrival.
    const allLogs = await this.prisma.inferenceLog.findMany({
      where: { conversationId: id },
      select: {
        id: true,
        provider: true,
        model: true,
        latencyMs: true,
        ttftMs: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        status: true,
        errorMessage: true,
        startedAt: true,
      },
      orderBy: { startedAt: "asc" },
    });
    const byId = new Map(allLogs.map((l) => [l.id, l]));

    // Logs not yet claimed by any message's direct link.
    const claimed = new Set(
      convo.messages.map((m) => m.inferenceLogId).filter((x): x is string => !!x),
    );
    const unclaimed = allLogs.filter((l) => !claimed.has(l.id));

    const messages = convo.messages.map((m) => {
      if (m.inferenceLogId) {
        return { ...m, inferenceLog: byId.get(m.inferenceLogId) ?? null };
      }
      if (m.role !== "ASSISTANT" || unclaimed.length === 0) {
        return { ...m, inferenceLog: null };
      }
      // Pick the unclaimed log closest in time to this message's createdAt.
      const target = m.createdAt.getTime();
      let best = unclaimed[0];
      let bestDiff = Math.abs(best.startedAt.getTime() - target);
      for (let i = 1; i < unclaimed.length; i += 1) {
        const diff = Math.abs(unclaimed[i].startedAt.getTime() - target);
        if (diff < bestDiff) {
          best = unclaimed[i];
          bestDiff = diff;
        }
      }
      // Remove so subsequent assistant messages don't reuse this log.
      unclaimed.splice(unclaimed.indexOf(best), 1);
      return { ...m, inferenceLog: best };
    });

    return { ...convo, messages };
  }

  @Patch(":id")
  async update(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: UpdateConversationDto,
  ) {
    const exists = await this.prisma.conversation.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException();
    return this.prisma.conversation.update({
      where: { id },
      data: {
        title: body.title,
        status: body.status,
        provider: body.provider,
        model: body.model,
      },
    });
  }

  /** Soft cancel — sets status=CANCELLED. The chatbot uses this when the user clicks Cancel. */
  @Post(":id/cancel")
  @HttpCode(200)
  async cancel(@Param("id", new ParseUUIDPipe()) id: string) {
    const exists = await this.prisma.conversation.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException();
    return this.prisma.conversation.update({
      where: { id },
      data: { status: ConversationStatus.CANCELLED },
    });
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id", new ParseUUIDPipe()) id: string) {
    await this.prisma.conversation.delete({ where: { id } }).catch(() => {
      throw new NotFoundException();
    });
  }

  @Post(":id/messages")
  async appendMessage(
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: AppendMessageDto,
  ) {
    return this.prisma.message.create({
      data: {
        conversationId: id,
        role: body.role,
        content: body.content,
        inferenceLogId: body.inferenceLogId,
      },
    });
  }
}
