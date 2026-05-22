# Deploy guide

The stack splits into:

- **Chatbot** (`chatbot/`) — stateless Next.js → **Vercel**.
- **Ingestion** (`ingestion/`) — NestJS + Postgres + Redis + background worker → **Render** (Blueprint included) or **Railway**.

Total time: ~10 minutes the first time. Render is the recommended path (one
file, all web UI, no CLI hassle). Railway is documented below as a fallback.

---

## 1. Ingestion on Render (recommended)

A `render.yaml` Blueprint at the repo root defines Postgres + Redis + the
ingestion service. Three managed resources, all wired together, all free
tier-compatible.

1. Sign in at https://dashboard.render.com (GitHub login works).
2. Click **New → Blueprint**.
3. Pick the `venkataCharan22/ollive-assignment` repo.
4. Render reads `render.yaml`, shows the three services (`ollive-postgres`,
   `ollive-redis`, `ollive-ingestion`), and asks you to confirm. Click **Apply**.
5. Wait ~5 minutes — Render provisions Postgres, Redis, then builds the
   Dockerfile and runs `prisma migrate deploy` on first start.
6. When the web service goes green, copy:
   - the **public URL** of `ollive-ingestion`
     (e.g. `https://ollive-ingestion-xxxx.onrender.com`)
   - the **generated `INGESTION_API_KEY`** from the service's "Environment" tab
7. Plug both into Vercel (see step 2 below).

### Free tier caveats

- **Postgres free** expires after 90 days. Upgrade to the $7/mo Starter plan
  to keep it past that, or move to a perpetually-free alternative (Neon,
  Supabase) and update `DATABASE_URL` manually.
- **Web service free** spins down after 15 min idle. Cold start is ~30s.
  Fine for a demo; not what you'd ship at scale.
- **Key Value (Redis) free** caps at 25MB. Our stream is capped at
  `MAXLEN ~100k`, well under the limit.

### Seed demo data (optional)

```bash
# Grab DATABASE_URL from Render's dashboard → ollive-postgres → "External Connection".
DATABASE_URL='<the-external-postgres-url>' \
  npx --workspace @ollive/ingestion prisma db seed
```

---

## Alternative: Ingestion on Railway

Railway gives you managed Postgres + Redis + a one-click container deploy.

```bash
# Install the Railway CLI (if you don't have it).
brew install railwayapp/railway/railway     # mac
# or: npm i -g @railway/cli

# Auth (opens browser).
railway login

# Create a new project, link this repo.
cd /Users/charan/Desktop/development/charan/ollive-assignment
railway init                          # accept defaults; name it "ollive"

# Add Postgres + Redis as plugins.
railway add --database postgres
railway add --database redis

# Create the ingestion service from the Dockerfile.
railway add --service ingestion
# Then in the Railway dashboard for the new "ingestion" service:
#   - Settings → Source → "Deploy from GitHub" → pick venkataCharan22/ollive-assignment
#   - Settings → Build → Root Directory: .  (repo root)
#   - Settings → Build → Dockerfile Path: ingestion/Dockerfile
#   - Settings → Networking → Generate Domain (gives you https://ollive-ingestion-production.up.railway.app)

# Set the env vars on the ingestion service.
railway variables --service ingestion \
  --set DATABASE_URL='${{Postgres.DATABASE_URL}}' \
  --set REDIS_URL='${{Redis.REDIS_URL}}' \
  --set INGESTION_PORT=4000 \
  --set INGESTION_API_KEY="$(openssl rand -hex 32)" \
  --set PII_REDACTION=true \
  --set NODE_ENV=production

# Deploy. Railway picks up the Dockerfile, builds, runs prisma migrate deploy, starts.
railway up --service ingestion

# Note the public URL — you'll need it for Vercel below.
railway status
```

### Optional: seed demo data once Railway is up

```bash
# Get the Railway DATABASE_URL out of the dashboard, then locally:
DATABASE_URL='<the railway public postgres url>' \
  npx --workspace @ollive/ingestion prisma db seed
```

---

---

## 2. Chatbot on Vercel

The repo has a `chatbot/vercel.json` that handles the monorepo build for you
(installs at the repo root so the SDK workspace resolves, builds the SDK,
then runs `next build`).

```bash
# Install Vercel CLI if needed.
npm i -g vercel

# From the repo root.
cd /Users/charan/Desktop/development/charan/ollive-assignment

# Link to a new Vercel project.
vercel link
#   ? Set up "ollive-assignment"? yes
#   ? Which scope? <your org / personal>
#   ? Link to existing project? no
#   ? What's your project's name? ollive-chat
#   ? In which directory is your code located? chatbot

# Add env vars. Use the Railway URL from step 1.
vercel env add INGESTION_URL production
#    paste: https://ollive-ingestion-production.up.railway.app

vercel env add NEXT_PUBLIC_INGESTION_URL production
#    paste: https://ollive-ingestion-production.up.railway.app

vercel env add INGESTION_API_KEY production
#    paste: <the same value you set on Railway>

vercel env add GROQ_API_KEY production           # optional — for real Llama inference
#    paste: <your gsk_... key>

vercel env add DEFAULT_PROVIDER production
#    paste: groq          (or mock if you didn't set GROQ_API_KEY)

vercel env add DEFAULT_MODEL production
#    paste: llama-3.1-8b-instant     (or mock-fast)

# Deploy to production.
vercel --prod
```

Vercel prints a URL like `https://ollive-chat.vercel.app`. Open it — the
chat UI loads, talks to your Railway ingestion, the dashboard fills in real
time as you send messages.

---

## 3. Verify the hosted setup

```bash
# Ingestion health.
curl https://<your-railway-url>/health
# Chatbot models endpoint.
curl https://<your-vercel-url>/api/models
```

If `models` returns `groq` entries, your Groq key made it through.
If only `mock` shows, the chatbot's `GROQ_API_KEY` env var isn't set.

---

## Submission

For `work@ollive.ai`:

- **Repo**: https://github.com/venkataCharan22/ollive-assignment
- **Demo**: https://ollive-chat.vercel.app  (replace with your actual URL)
- **Architecture notes**: see [`ARCHITECTURE.md`](ARCHITECTURE.md) in the repo
- **One-line summary**: Multi-provider LLM chatbot (OpenAI / Anthropic / Gemini / Groq / mock) with a custom SDK that ships inference logs through an event-based pipeline (Redis Streams) to a Postgres-backed observability dashboard. Docker Compose for local, Vercel + Railway for hosted, K8s manifests for self-hosted.

---

## Troubleshooting

**"INGESTION_API_KEY is not configured" 401 on the chatbot.**  
The key on Railway and the key on Vercel must match exactly. Re-set both.

**Vercel build fails with `Cannot find module '@ollive/llm-sdk'`.**  
The `chatbot/vercel.json` build command must run from the repo root. Ensure
Vercel's "Root Directory" project setting is `chatbot/` and the
`vercel.json` exists.

**Railway shows `prisma migrate deploy` errored.**  
Check that `DATABASE_URL` was set on the ingestion service and that the
Postgres plugin is in the same Railway project. The Dockerfile runs migrate
on container start; the second deploy usually succeeds because the env var
is now picked up.

**Dashboard stays empty.**  
The ingestion worker may not have started — check `railway logs --service
ingestion` for `consumer ... started`. If not, restart the service.
