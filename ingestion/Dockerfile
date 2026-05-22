# syntax=docker/dockerfile:1
# Build stage — installs all workspace deps, runs prisma generate, compiles TS.
FROM node:20-alpine AS build
WORKDIR /repo

# Workspace manifests first so layer cache survives source edits.
COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY sdk/package.json sdk/
COPY ingestion/package.json ingestion/
COPY chatbot/package.json chatbot/

RUN npm install --include=dev --workspaces --include-workspace-root

# Now copy source and build.
COPY ingestion ingestion
RUN npx --workspace @ollive/ingestion prisma generate \
  && npm run build -w @ollive/ingestion

# ---------------------------------------------------------------------------
# Runtime — slim image with prod deps only.
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# We need prisma/CLI available at runtime to apply migrations on boot.
COPY package.json package-lock.json* ./
COPY ingestion/package.json ingestion/
RUN npm install --omit=dev --workspaces --include-workspace-root \
  && npm install -g prisma@^6.1.0

COPY --from=build /repo/ingestion/dist ./ingestion/dist
COPY ingestion/prisma ./ingestion/prisma

WORKDIR /app/ingestion

EXPOSE 4000
# Apply schema, then start. `migrate deploy` is idempotent.
CMD sh -c "prisma migrate deploy && node dist/main.js"
