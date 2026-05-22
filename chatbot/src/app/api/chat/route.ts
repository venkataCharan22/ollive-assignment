import { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import type { ChatMessage, ProviderName } from "@ollive/llm-sdk";
import { ingestion } from "@/lib/ingestion";
import { makeClient } from "@/lib/sdk-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ChatBody {
  conversationId: string;
  message: string;
  provider: ProviderName;
  model: string;
  /** Optional system prompt; sent only on the first turn of a conversation. */
  system?: string;
}

/**
 * POST /api/chat — streams an assistant response as Server-Sent Events.
 *
 * Lifecycle:
 *   1. Load existing message history from ingestion service.
 *   2. Append user message to history + persist it to the DB.
 *   3. Open a streaming completion via the SDK; forward deltas to the client.
 *   4. On finish, persist the assistant message. The SDK has already shipped
 *      an InferenceLog asynchronously.
 *   5. On client disconnect, abort the upstream call. The SDK logs status=cancelled.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as ChatBody;

  // Load existing conversation so we can replay history into the LLM. The
  // dashboard's "Resume" button relies on this — every turn pulls fresh.
  const convo = await ingestion.getConversation(body.conversationId);
  if (convo.status === "CANCELLED") {
    return new Response("Conversation is cancelled", { status: 409 });
  }

  const history: ChatMessage[] = convo.messages.map((m) => ({
    role: m.role.toLowerCase() as ChatMessage["role"],
    content: m.content,
  }));

  // System prompt only on first turn (if provided and history has none).
  if (body.system && !history.some((m) => m.role === "system")) {
    history.unshift({ role: "system", content: body.system });
  }
  history.push({ role: "user", content: body.message });

  // Persist user message right away so it shows on a reload mid-stream.
  await ingestion.appendMessage(body.conversationId, {
    role: "USER",
    content: body.message,
  });

  const requestId = randomUUID();
  const client = makeClient(body.provider);
  const upstreamAbort = new AbortController();

  // If the browser disconnects (user navigates away or hits Cancel),
  // cascade the abort up to the provider SDK.
  req.signal.addEventListener("abort", () => upstreamAbort.abort());

  const encoder = new TextEncoder();
  let assistantBuffer = "";
  let streamError: string | undefined;
  let finishReason: "done" | "error" | "aborted" = "done";

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Tell the client up-front which requestId this stream maps to so they
      // can correlate to the dashboard.
      controller.enqueue(sseEvent({ type: "meta", requestId }));

      try {
        for await (const chunk of client.chatStream(
          {
            model: body.model,
            messages: history,
            conversationId: body.conversationId,
            requestId,
            tags: { surface: "chatbot" },
          },
          upstreamAbort.signal,
        )) {
          if (chunk.delta) {
            assistantBuffer += chunk.delta;
            controller.enqueue(sseEvent({ type: "delta", text: chunk.delta }));
          } else if (chunk.error) {
            streamError = chunk.error;
            finishReason = /aborted/i.test(chunk.error) ? "aborted" : "error";
            controller.enqueue(sseEvent({ type: "error", message: chunk.error }));
          } else if (chunk.done) {
            controller.enqueue(sseEvent({ type: "done", requestId }));
          }
        }
      } catch (err) {
        streamError = (err as Error).message;
        finishReason = upstreamAbort.signal.aborted ? "aborted" : "error";
        controller.enqueue(sseEvent({ type: "error", message: streamError }));
      } finally {
        // Persist BEFORE closing the controller. On serverless runtimes
        // (Vercel), the function can be torn down the instant the response
        // body ends — any await after controller.close() risks being killed
        // mid-flight. Doing this work first costs only a few ms of perceived
        // latency (the browser is already rendering the streamed text).
        if (assistantBuffer.length > 0) {
          // Note: we intentionally don't pass inferenceLogId here. The
          // worker backfills the link once the InferenceLog row lands.
          // See schema.prisma's Message.inferenceLogId comment.
          await ingestion
            .appendMessage(body.conversationId, {
              role: "ASSISTANT",
              content: assistantBuffer,
            })
            .catch((err) => {
              console.error("failed to persist assistant message:", err);
            });
        }
        await ingestion
          .updateConversation(body.conversationId, {
            provider: body.provider,
            model: body.model,
          })
          .catch(() => undefined);
        await client.flush(2000).catch(() => undefined);

        controller.close();
      }
    },
    cancel() {
      upstreamAbort.abort();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function sseEvent(payload: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}
