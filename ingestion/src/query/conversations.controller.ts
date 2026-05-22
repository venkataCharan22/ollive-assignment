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

    // Loose join: load inference logs by id and zip them onto each message.
    // (See schema.prisma's comment on Message.inferenceLogId for why we don't
    // use a Prisma relation here.)
    const logIds = convo.messages
      .map((m) => m.inferenceLogId)
      .filter((id): id is string => !!id);
    const logs = logIds.length
      ? await this.prisma.inferenceLog.findMany({
          where: { id: { in: logIds } },
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
          },
        })
      : [];
    const byId = new Map(logs.map((l) => [l.id, l]));
    return {
      ...convo,
      messages: convo.messages.map((m) => ({
        ...m,
        inferenceLog: m.inferenceLogId ? byId.get(m.inferenceLogId) ?? null : null,
      })),
    };
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
