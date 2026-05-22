# Ollive — LLM chatbot with real-time inference observability

Hiring assignment for **Ollive — Founding Fullstack Engineer**. Multi-provider
LLM chatbot, custom logging SDK, ingestion pipeline, and observability
dashboards. One command boots the whole stack.

> **TL;DR for reviewers:** `cp .env.example .env && docker compose up --build`,
> then open <http://localhost:3000>. No API keys needed — the mock provider
> ships a streaming response so the dashboard fills up the moment you send
> a message.

---

## What's in the box

| Component | Path | What it does |
| --- | --- | --- |
| **`@ollive/llm-sdk`** | [`sdk/`](sdk/) | Thin wrapper around OpenAI, Anthropic, Gemini, Groq (Llama/Mixtral/Gemma at sub-200ms TTFT), and a mock provider. Captures latency, TTFT, tokens, status, errors. Redacts PII. Ships logs to the ingestion service asynchronously so observability never blocks the chat. |
| **Ingestion service** | [`ingestion/`](ingestion/) | NestJS + Prisma + Postgres + Redis Streams. Receives logs, fans them onto a Stream, a worker consumer-group persists to Postgres. Exposes conversation CRUD and dashboard query endpoints. |
| **Chatbot** | [`chatbot/`](chatbot/) | Next.js 15 App Router. Streaming chat UI with conversation list, resume, and **cancel-mid-stream**. Dashboard with latency / throughput / error / token charts. |
| **Docker Compose** | [`docker-compose.yml`](docker-compose.yml) | One-command setup: Postgres + Redis + ingestion + chatbot. |
| **K8s manifests** | [`k8s/`](k8s/) | Self-hosted deploy (k3s / kind / any cluster). Namespace, secrets, StatefulSets, Deployments, HPA, Ingress. |

### Assignment checklist

Core requirements:

- [x] Chatbot application — multi-turn, conversational context, simple UI.
- [x] Lightweight SDK / wrapper capturing model, provider, latency, tokens, timestamps, status/errors, conversation ID, input/output previews.
- [x] Ingestion pipeline — receives, validates, parses, extracts metadata, stores in DB.
- [x] Database storage for chat messages, inference logs, extracted metadata.
- [x] README with setup, architecture, schema, tradeoffs, what's next.
- [x] Architecture notes (see [`ARCHITECTURE.md`](ARCHITECTURE.md)).

Guaranteed-interview bonus list:

- [x] **Multi-provider support** — OpenAI / Anthropic / Gemini / Groq / mock, behind one `Provider` interface.
- [x] **Streaming responses** — SSE end-to-end, with TTFT measured per call.
- [x] **Latency + throughput + error dashboards** — live, auto-refresh every 5s, percentile aggregations.
- [x] **Docker Compose one-command setup** — `docker compose up --build`.
- [x] **Event-based architecture** — Redis Streams between the API and the persistence worker (consumer groups, autoclaim for crash recovery).
- [x] **PII redaction** — email / phone / credit card / SSN / API key patterns, applied in the SDK and re-applied defensively in the worker.
- [x] **Deploy on self-hosted k8s** — full manifest set in [`k8s/`](k8s/).
- [x] **Frontend conversation management** — list / resume / cancel / delete.

---

## Quick start (Docker Compose)

```bash
# 1. Configure environment.
cp .env.example .env
#    Optionally set OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY / GROQ_API_KEY in .env.
#    Leave them blank to use the mock provider.

# 2. Boot the stack.
docker compose up --build

# 3. Open the app.
open http://localhost:3000          # chat UI
open http://localhost:3000/dashboard # observability dashboard

# 4. (Optional) Seed demo data so the dashboard has history before your first chat.
docker compose exec ingestion sh -c "cd /app/ingestion && npx prisma db seed"
```

Tear down with `docker compose down`. Add `-v` to wipe the Postgres + Redis
volumes if you want a clean slate.

### Health checks

```bash
curl http://localhost:4000/health
# { "status": "ok", "service": "ollive-ingestion", "db": "ok", ... }
```

### Smoke-test the ingestion API directly

```bash
curl -X POST http://localhost:4000/ingest/inference \
  -H 'content-type: application/json' \
  -H 'x-ollive-key: dev-ingest-key-change-me' \
  -d '{
    "requestId":"smoke-1",
    "conversationId":"00000000-0000-0000-0000-000000000001",
    "provider":"mock","model":"mock-fast","status":"ok",
    "startedAt":"2026-05-22T12:00:00.000Z",
    "finishedAt":"2026-05-22T12:00:00.350Z",
    "latencyMs":350,"streamed":false,
    "usage":{"promptTokens":12,"completionTokens":40,"totalTokens":52},
    "inputPreview":"hi","outputPreview":"hello there",
    "messages":[{"role":"user","content":"hi"}],
    "output":"hello there","sdkVersion":"0.1.0"
  }'
# { "accepted": true, "streamId": "1716379200000-0" }
```

---

## Local dev (without Docker)

```bash
# 1. Start Postgres + Redis only.
docker compose up postgres redis -d

# 2. Install workspace deps.
npm install

# 3. Build the SDK once (chatbot consumes it as a workspace package).
npm run build -w @ollive/llm-sdk

# 4. Apply schema + seed.
cp .env.example .env
export $(grep -v '^#' .env | xargs)
export DATABASE_URL=postgresql://ollive:ollive@localhost:5432/ollive?schema=public
export REDIS_URL=redis://localhost:6379
npm run prisma:migrate -w @ollive/ingestion
npm run prisma:seed -w @ollive/ingestion

# 5. Run services in separate terminals.
npm run start:dev -w @ollive/ingestion   # http://localhost:4000
INGESTION_URL=http://localhost:4000 NEXT_PUBLIC_INGESTION_URL=http://localhost:4000 \
  npm run dev -w @ollive/chatbot         # http://localhost:3000
```

---

## Schema design

Three core tables (see [`ingestion/prisma/schema.prisma`](ingestion/prisma/schema.prisma) for the full source):

### `Conversation`
A chat session. Holds default `provider` / `model` so the picker can be sticky
per conversation, plus a `status` enum (`ACTIVE` / `CANCELLED` / `ARCHIVED`)
that powers the soft-cancel UX without losing history. Indexed on
`(status, updatedAt DESC)` to make the sidebar listing fast.

### `Message`
A single user / assistant / system turn rendered in the chat UI. Optional
`inferenceLogId` (a plain `@unique` column, **not** a foreign key on purpose)
loosely links the assistant message to the LLM call that produced it. The
chatbot persists the assistant message as soon as the stream closes; the
`InferenceLog` itself arrives moments later through the async Redis Stream
pipeline. A hard FK would reject the message-write whenever the log hasn't
landed yet, so the worker backfills this column via UPDATE on the most-recent
unlinked ASSISTANT message in the conversation once it persists the
`InferenceLog`. The conversation getter does a single secondary lookup to
zip the logs back onto each message. Indexed on `(conversationId, createdAt)`.

### `InferenceLog`
One row per LLM call, regardless of streaming. The primary key is the
SDK-supplied `requestId`, which makes retries idempotent — the worker uses
`upsert(where: { id }, update: {}, create: …)` so duplicate deliveries from
the Redis Stream don't double-insert. Indexed on:
- `(conversationId, startedAt)` — per-conversation timelines,
- `(provider, startedAt DESC)` — provider drill-downs,
- `(status, startedAt DESC)` — error filtering,
- `(startedAt DESC)` — global recent-calls view.

The `raw` JSONB column stores the full original event. If we add a new metric
tomorrow (say, cache hit rate) we can backfill from `raw` without an SDK
redeploy.

### What we *didn't* model
- **Users / auth** — out of scope for the assignment, but the schema has no
  cross-cutting joins that would make adding them painful.
- **Multi-tenant org_id** — same: easy to add as a column with composite
  indexes, deliberately omitted to keep the demo readable.
- **Time-series rollups** — at higher write volume you'd materialise the
  dashboard's `percentile_cont` queries into hourly buckets (Postgres
  materialized view, or push to ClickHouse). For demo traffic the live SQL is
  faster to build and runs in single-digit ms.

---

## Tradeoffs

**Postgres-only for both chat data and metrics.** At very high inference
volume (>>1k req/s sustained), the dashboard's percentile queries on the
`InferenceLog` table will start to drag. The right escalation is a separate
time-series store (ClickHouse, TimescaleDB, or a Postgres rollup table) and
keep chat data in vanilla Postgres. For this assignment, single-store keeps
the schema legible and avoids a second backup/restore story.

**Fire-and-forget log shipping in the SDK.** A user-facing chatbot must not
stall on observability. The SDK has one inline retry, then drops to a warning.
If at-least-once guarantees are required, swap the in-process transport for a
sidecar agent (e.g. Fluent Bit) that tails a local log file — that's the
standard pattern and the SDK boundary is already aligned for it.

**Redis Streams instead of Kafka.** Streams give us the consumer-group
semantics we need (at-most-once dispatch, ack-or-redeliver, autoclaim for
crashes) without standing up a Kafka cluster. For sub-100k events/s on a
single node this is the pragmatic choice. We'd graduate to Kafka or Redpanda
once we need cross-region replication or per-tenant partitioning.

**PII redaction is regex-based.** Catches the obvious leaks (emails, phones,
SSNs, credit cards, API keys) at near-zero cost. Production should layer in a
proper NER-based redactor (Microsoft Presidio, AWS Comprehend) for names and
addresses — the SDK's `redact` hook is the right insertion point.

**No auth on the chatbot.** This is a demo; in production the chatbot would
sit behind your existing IdP (OIDC or session-cookie) and pass a tenant id
through to the SDK's `tags`. The ingestion API already requires `X-Ollive-Key`
so the surface is internal-only by default.

**Prisma over a hand-written query layer.** Prisma's migration story is the
right choice for a 2-person team optimising for speed; the few raw `$queryRaw`
calls in the metrics controller are the small bits where we want SQL primitives
(`percentile_cont`) that the ORM doesn't expose.

**SSE over WebSockets for streaming.** Half-duplex is enough for chat
streaming, SSE works on stock Next.js without custom server config, and it
plays well with HTTP/2 and the ingress annotations in [`k8s/60-ingress.yaml`](k8s/60-ingress.yaml).

---

## What I'd build next (with more time)

1. **Trace propagation** — pass a W3C `traceparent` from the chatbot through
   the SDK into the inference log, so the dashboard can pivot from a slow
   request to the upstream provider's request id.
2. **Per-tenant ingestion keys + scoped dashboards** — one shared key today;
   make it a per-tenant signed token (JWT) and filter the dashboard by tenant.
3. **Cost calculator** — multiply `promptTokens` / `completionTokens` by the
   provider's published price and surface a "$ this hour" stat. The data is
   already there; this is one SQL query and a Stat tile.
4. **Replay endpoint** — `/replay/:requestId` re-runs an old call against the
   current model. Useful for regression testing prompt changes.
5. **Streaming compression for large prompts** — currently we ship the full
   message body in the log. For long prompts (RAG context), gzip before
   posting to ingestion.
6. **TimescaleDB hypertable for `InferenceLog`** — once write volume justifies
   it. Same Postgres deployment, no new ops surface.
7. **Open-telemetry exporter** — replace the custom transport with an OTLP
   exporter so the same SDK works with Grafana Cloud / Honeycomb / Tempo.
8. **Property-based redaction tests** — the regex set today is reviewed by
   eye; add `fast-check` cases that ensure no synthesised PII leaks through.

---

## Architecture & operations

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for ingestion flow, logging strategy,
scaling considerations, and failure handling assumptions.

For self-hosted Kubernetes deployment, see [`k8s/README.md`](k8s/README.md).

---

## Hosted deployment

The stack splits cleanly along a stateful / stateless line:

- **Chatbot (Next.js)** — fully stateless. Deploys to Vercel or any Node host.
- **Ingestion** — needs Postgres + Redis + a long-running worker. Vercel
  serverless functions can't host the worker. Use Railway, Render, Fly.io,
  Hetzner, or any cluster.

### Quickest path (Vercel + Railway)

```bash
# 1. Push to GitHub.
gh repo create ollive-assignment --public --source=. --push

# 2. Spin up the ingestion side on Railway.
#    Railway has 1-click templates for Postgres + Redis. Add a service
#    pointed at this repo's `ingestion/Dockerfile`, set:
#      DATABASE_URL, REDIS_URL, INGESTION_API_KEY (any random string)
#    Railway exposes a public URL like https://ollive-ingestion.up.railway.app
#    Run the seed once: railway run -s ingestion npx prisma db seed

# 3. Deploy the chatbot to Vercel.
vercel link --project ollive          # creates a new Vercel project
vercel env add INGESTION_URL           # the Railway URL
vercel env add NEXT_PUBLIC_INGESTION_URL
vercel env add INGESTION_API_KEY       # must match Railway
vercel env add GROQ_API_KEY            # optional; mock works without any keys
vercel --prod
```

Set the chatbot's **Root Directory** to `chatbot/` in the Vercel project
settings — the SDK is a workspace dep, so Vercel needs to install from the
repo root. Set the **Install Command** to `npm install` and the **Build
Command** to `npm run build -w @ollive/llm-sdk && npm run build` to compile
the SDK before the chatbot's `next build` runs.

### Everything-in-one alternative (single VPS)

If you'd rather not split, a $5/mo Hetzner VPS runs the full
`docker-compose.yml` as-is. Add a Caddy or Nginx reverse proxy in front for
TLS. See [`k8s/`](k8s/) for a Kubernetes flavour of the same thing.

---

## Submission

- **Repository**: this directory.
- **Email**: `work@ollive.ai`
- **Stack**: Node 20, TypeScript 5.7, Next.js 15, NestJS 10, Prisma 6, Postgres 16, Redis 7.
- **Author**: Charan (kodelasaradhi@gmail.com)
