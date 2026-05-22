/**
 * Thin server-side client for the ingestion service. Used by Next.js API routes
 * to read/write conversations and messages. We don't put the auth key in
 * NEXT_PUBLIC env vars — only the server-side INGESTION_URL/INGESTION_API_KEY
 * are ever used here.
 */

const baseUrl = () =>
  (process.env.INGESTION_URL ?? "http://localhost:4000").replace(/\/$/, "");

const headers = () => ({
  "content-type": "application/json",
  "x-ollive-key": process.env.INGESTION_API_KEY ?? "dev-ingest-key-change-me",
});

export type ConvoStatus = "ACTIVE" | "CANCELLED" | "ARCHIVED";

export interface ConversationSummary {
  id: string;
  title: string | null;
  provider: string;
  model: string;
  status: ConvoStatus;
  createdAt: string;
  updatedAt: string;
  _count: { messages: number };
}

export interface MessageRecord {
  id: string;
  role: "USER" | "ASSISTANT" | "SYSTEM";
  content: string;
  createdAt: string;
  inferenceLog?: {
    id: string;
    provider: string;
    model: string;
    latencyMs: number;
    ttftMs: number | null;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    status: "OK" | "ERROR" | "CANCELLED";
    errorMessage?: string | null;
  } | null;
}

export interface ConversationDetail extends ConversationSummary {
  messages: MessageRecord[];
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    ...init,
    headers: { ...headers(), ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ingestion ${res.status} ${path}: ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return undefined as unknown as T;
  return (await res.json()) as T;
}

export const ingestion = {
  listConversations: (status?: ConvoStatus) =>
    call<ConversationSummary[]>(`/conversations${status ? `?status=${status}` : ""}`),

  getConversation: (id: string) => call<ConversationDetail>(`/conversations/${id}`),

  createConversation: (body: { title?: string; provider: string; model: string }) =>
    call<ConversationSummary>(`/conversations`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  updateConversation: (
    id: string,
    body: Partial<{ title: string; status: ConvoStatus; provider: string; model: string }>,
  ) =>
    call<ConversationSummary>(`/conversations/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  cancelConversation: (id: string) =>
    call<ConversationSummary>(`/conversations/${id}/cancel`, { method: "POST" }),

  deleteConversation: (id: string) =>
    call<void>(`/conversations/${id}`, { method: "DELETE" }),

  appendMessage: (
    id: string,
    body: { role: "USER" | "ASSISTANT" | "SYSTEM"; content: string; inferenceLogId?: string },
  ) => call<MessageRecord>(`/conversations/${id}/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  }),

  metricsSummary: (hours = 24) =>
    call<{
      since: string;
      hours: number;
      overall: MetricsRow;
      byProvider: MetricsRow[];
    }>(`/metrics/summary?hours=${hours}`),

  metricsTimeseries: (hours = 24, bucket: "minute" | "hour" = "hour") =>
    call<{
      since: string;
      bucket: string;
      points: Array<{
        bucket: string;
        provider: string;
        total: number;
        errors: number;
        p50: number;
        p95: number;
        avgLatency: number;
        totalTokens: number;
      }>;
    }>(`/metrics/timeseries?hours=${hours}&bucket=${bucket}`),

  recentLogs: () =>
    call<
      Array<{
        id: string;
        conversationId: string;
        provider: string;
        model: string;
        status: "OK" | "ERROR" | "CANCELLED";
        startedAt: string;
        latencyMs: number;
        ttftMs: number | null;
        streamed: boolean;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        inputPreview: string;
        outputPreview: string;
        errorMessage: string | null;
      }>
    >(`/metrics/recent`),
};

export interface MetricsRow {
  provider?: string;
  total: number;
  ok: number;
  errors: number;
  cancelled: number;
  p50: number;
  p95: number;
  p99: number;
  avgLatency: number;
  avgTtft: number | null;
  totalTokens: number;
}
