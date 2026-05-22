# syntax=docker/dockerfile:1
# Build stage — install workspace deps and compile the SDK + Next.js app.
FROM node:20-alpine AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY tsconfig.base.json ./
COPY sdk/package.json sdk/
COPY ingestion/package.json ingestion/
COPY chatbot/package.json chatbot/

RUN npm install --include=dev --workspaces --include-workspace-root

# Compile the SDK first so Next can resolve it as a local package.
COPY sdk sdk
RUN npm run build -w @ollive/llm-sdk

COPY chatbot chatbot
RUN npm run build -w @ollive/chatbot

# ---------------------------------------------------------------------------
# Runtime — Next's standalone output gives us a slim image.
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /repo/chatbot/.next/standalone ./
COPY --from=build /repo/chatbot/.next/static ./chatbot/.next/static
COPY --from=build /repo/chatbot/public ./chatbot/public

EXPOSE 3000
WORKDIR /app/chatbot
CMD ["node", "server.js"]
