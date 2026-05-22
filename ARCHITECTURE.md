# Architecture notes

## High-level flow

```
                       ┌──────────────────────────┐
                       │      Browser (UI)        │
                       │  Chat ── SSE stream ◀──┐ │
                       │  Dashboard ── polls ◀──┤ │
                       └────────────┬───────────┘ │
                            HTTPS   │             │
                                    ▼             │
                       ┌──────────────────────────┴┐
                       │  Next.js (chatbot)        │
                       │  ─ /api/chat              │
                       │  ─ /api/conversations/*   │
                       │  ─ /api/metrics/*         │
                       │                           │
                       │  uses @ollive/llm-sdk ────┼──── fire & forget log POST
                       └────────────┬──────────────┘
                            HTTP    │                      ┌──────────────┐
                                    ▼                      │   OpenAI /   │
        SDK ─── streaming completion ────────────────────▶ │  Anthropic / │
                                    ▲                      │  Gemini /    │
                                    │                      │  Mock        │
                                    │ ack-and-stream       └──────────────┘
                                    │
                                    │
                       ┌────────────┴──────────────┐
                       │  Ingestion API (NestJS)   │
                       │  POST /ingest/inference   │   ◀── X-Ollive-Key
                       │  ─── XADD ─────────────┐  │
                       └────────────┬───────────┘  │
                                    │              │
                                    ▼              │
                             Redis Streams         │
                             ollive:inference-logs │
                                    │              │
                                    │  XREADGROUP  │
                                    ▼              │
                       ┌───────────────────────────┴┐
                       │  Worker (in-process)       │
                       │  ─ validate                │
                       │  ─ defensively redact PII  │
                       │  ─ upsert InferenceLog     │
                       │  ─ XACK or leave for       │
                       │    XAUTOCLAIM              │
                       └────────────┬───────────────┘
                                    │
                                    ▼
                              Postgres 16
                       Conversation / Message /
                          InferenceLog (JSONB raw)
```

## Ingestion flow

1. **SDK → ingestion API.** The Next.js `/api/chat` route uses
   `@ollive/llm-sdk` to call the provider. As soon as the response (or error,
   or cancellation) is known, the SDK assembles an `InferenceLog` and POSTs
   it to `/ingest/inference`. The POST is **fire-and-forget** with one inline
   retry — the user-facing stream is never blocked on observability.
2. **Ingestion API → Redis Streams.** The API validates the payload with
   `class-validator`, then publishes onto the `ollive:inference-logs` stream
   (`XADD ~ MAXLEN 100000` — approximate trim keeps memory bounded). Returns
   `202 Accepted` immediately. The HTTP boundary is the durability point;
   from here on the event is in Redis.
3. **Worker → Postgres.** The worker (`StreamConsumerService`) reads from
   the stream in a consumer group via `XREADGROUP > BLOCK 5000`. For each
   event it:
   - upserts the parent `Conversation` row (idempotent),
   - applies defensive PII redaction (defense-in-depth: an old SDK shouldn't
     leak raw PII into the DB),
   - upserts the `InferenceLog` keyed by `requestId` (so duplicate stream
     deliveries collapse to one row),
   - `XACK`s the entry. Failure to persist means no ack → `XAUTOCLAIM`
     picks it up after 30s and another consumer retries.

## Logging strategy

- **One log per call, not per token.** Streaming chunks are aggregated in
  memory inside the SDK; we emit a single `InferenceLog` when the stream
  ends (or errors / aborts). Avoids hammering the API with thousands of
  small writes per response.
- **Captured fields**: `requestId` (idempotency key), `conversationId`
  (session glue), `provider`, `model`, `status` (`ok` / `error` / `cancelled`),
  `startedAt` / `finishedAt`, `latencyMs`, `ttftMs` (streaming only),
  `streamed` (bool), token usage (prompt / completion / total), input + output
  previews (≤500 chars), full output + messages (for replay), error code +
  message, free-form `tags` (we use `surface: "chatbot"`), `sdkVersion`,
  full `raw` JSONB.
- **Preview vs full payload.** The dashboard's hot path (`/metrics/recent`,
  `/metrics/summary`) reads only preview columns and aggregates. The full
  payload is loaded only on the conversation-detail screen. This keeps the
  dashboard query plan in single-digit ms even as `InferenceLog` grows.
- **Tags.** Free-form `tags: Record<string,string>` lets callers slice the
  dashboard later without a schema change (e.g. `feature: "summarize"`,
  `experiment: "new-prompt-v2"`).

## Scaling considerations

| Bottleneck | When it hits | What you do |
| --- | --- | --- |
| Ingestion HTTP throughput | ~5k req/s on a single Node process | Bump replicas. Stateless behind the load balancer. HPA in [`k8s/40-ingestion.yaml`](k8s/40-ingestion.yaml) does this on CPU. |
| Worker persistence | When `XPENDING` lag grows | Same HPA — replicas join the same consumer group, Streams dispatches one event per consumer. |
| Postgres write QPS | ~10k inserts/s on RDS m5.large | Use COPY in a batched-flush worker, then escalate to TimescaleDB or ClickHouse for the time-series table. Schema split is already clean. |
| Postgres dashboard queries | When `InferenceLog` >> 100M rows | Add a `mv_inference_minutely` materialized view (refresh every 30s) for the percentile charts; keep on-demand queries for ad-hoc filtering. |
| Redis Streams memory | When `MAXLEN 100k` becomes too aggressive | Bump the cap, or move to Redpanda / Kafka with per-tenant partitions. |
| LLM provider rate limits | Anytime, all the time | The SDK is the right place for per-provider token-bucket throttling and circuit-breaking. Not implemented in this assignment; would slot into `providers/base.ts`. |

## Failure handling

- **Provider 5xx / timeout.** The SDK catches the exception, emits an
  `InferenceLog` with `status=error`, surfaces the error to the chat UI.
  The user sees an error bubble, the dashboard's error rate ticks up.
- **Network blip between SDK and ingestion.** One inline retry. If it
  still fails, the SDK logs to stderr and the chat continues — observability
  is best-effort. For at-least-once, deploy a sidecar log agent.
- **Ingestion service down when SDK POSTs.** Same as above. The chat
  doesn't notice. Sustained outage shows as a gap in the dashboard;
  recovery is implicit when the service comes back.
- **Worker crashes mid-insert.** The event isn't acked. `XAUTOCLAIM`
  picks it up 30s later and another worker retries. The `InferenceLog`
  upsert is idempotent on `requestId`, so even a duplicate delivery is safe.
- **Postgres unavailable.** Worker retry loop logs and waits. Stream entries
  pile up (bounded by `MAXLEN ~100k`). Once Postgres comes back, the
  backlog drains automatically.
- **Browser closes mid-stream.** Next.js's `req.signal` aborts → server
  AbortController cascades to the SDK → provider stream closes early. The
  SDK emits `status=cancelled` with the partial output and TTFT it captured.
  The assistant message persisted in the DB contains whatever streamed before
  the abort, so resuming the conversation shows the partial response.
- **User clicks "Cancel" on the conversation.** The browser aborts the
  in-flight `/api/chat` fetch (same path as above) *and* posts to
  `/api/conversations/:id/cancel`, flipping the `status` to `CANCELLED`.
  Future sends to that conversation return 409.
- **PII slips past the SDK.** The worker applies the same regex set defensively
  before writing. If a new pattern is needed, it ships independently of the
  SDK.

## Security notes

- The ingestion API is gated by `X-Ollive-Key` (`ApiKeyGuard`). Browsers
  never see this key — only the Next.js server uses it.
- Provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`)
  live in the chatbot server env, never crossed to the browser. The
  `/api/models` endpoint only returns model labels, not key presence beyond
  "available / not".
- CORS is permissive (`cors: true` on Nest) because this is a demo and the
  ingestion API is intended to live behind a private VPC in production. For
  a public deployment, restrict to known origins.
- Prisma uses parameterised queries throughout; the only raw SQL is in
  `metrics.controller.ts` and uses `Prisma.sql` (template-tagged, escaped).

## Operational runbook (the short version)

- **Live tail of inference logs**: `docker compose logs -f ingestion | grep accepted`
- **Replay the stream**: `docker compose exec redis redis-cli XREAD COUNT 100 STREAMS ollive:inference-logs 0`
- **Drain failing entries**: workers pick stale pending entries up automatically
  every 15s. To force, restart the ingestion container — the new worker joins
  the group and `XAUTOCLAIM` takes the orphans on the first tick.
- **Wipe and reseed for a demo**: `docker compose down -v && docker compose up --build`
  then `docker compose exec ingestion sh -c "cd /app/ingestion && npx prisma db seed"`.
