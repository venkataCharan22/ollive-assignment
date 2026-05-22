"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Role = "USER" | "ASSISTANT" | "SYSTEM";

interface InferenceMeta {
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
}

interface Message {
  id: string;
  role: Role;
  content: string;
  createdAt: string;
  inferenceLog?: InferenceMeta | null;
}

interface ConversationSummary {
  id: string;
  title: string | null;
  provider: string;
  model: string;
  status: "ACTIVE" | "CANCELLED" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
  _count: { messages: number };
}

interface ConversationDetail extends ConversationSummary {
  messages: Message[];
}

interface ModelOption {
  provider: "openai" | "anthropic" | "google" | "groq" | "mock";
  model: string;
  label: string;
}

interface ModelsResponse {
  models: ModelOption[];
  defaultProvider: string;
  defaultModel: string;
}

/**
 * Main client-side chat workspace. Owns the sidebar (conversation list),
 * the active chat thread, the model picker, the SSE stream parser, and the
 * Cancel button wiring (AbortController on fetch → server cascades to SDK).
 */
export default function ChatWorkspace() {
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [convo, setConvo] = useState<ConversationDetail | null>(null);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [provider, setProvider] = useState<ModelOption["provider"]>("mock");
  const [model, setModel] = useState<string>("mock-fast");
  const [input, setInput] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Initial load — models + conversation list.
  useEffect(() => {
    void (async () => {
      const [mRes, cRes] = await Promise.all([
        fetch("/api/models").then((r) => r.json() as Promise<ModelsResponse>),
        fetch("/api/conversations").then((r) => r.json() as Promise<ConversationSummary[]>),
      ]);
      setModels(mRes);
      setProvider(mRes.defaultProvider as ModelOption["provider"]);
      setModel(mRes.defaultModel);
      setConversations(cRes);
    })();
  }, []);

  // Load full conversation whenever the active id changes.
  useEffect(() => {
    if (!activeId) {
      setConvo(null);
      return;
    }
    void (async () => {
      const res = await fetch(`/api/conversations/${activeId}`).then(
        (r) => r.json() as Promise<ConversationDetail>,
      );
      setConvo(res);
      // Sync the picker to whatever the conversation was last using.
      setProvider(res.provider as ModelOption["provider"]);
      setModel(res.model);
    })();
  }, [activeId]);

  // Auto-scroll on new content.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [convo?.messages.length, streamingText]);

  const refreshConversations = useCallback(async () => {
    const cRes = await fetch("/api/conversations").then(
      (r) => r.json() as Promise<ConversationSummary[]>,
    );
    setConversations(cRes);
  }, []);

  const createNewConversation = useCallback(async () => {
    const res = await fetch("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, model, title: null }),
    });
    const created = (await res.json()) as ConversationSummary;
    await refreshConversations();
    setActiveId(created.id);
  }, [provider, model, refreshConversations]);

  const cancelConversation = useCallback(
    async (id: string) => {
      if (abortRef.current && activeId === id) {
        abortRef.current.abort();
      }
      await fetch(`/api/conversations/${id}/cancel`, { method: "POST" });
      await refreshConversations();
      if (activeId === id) {
        const detail = await fetch(`/api/conversations/${id}`).then(
          (r) => r.json() as Promise<ConversationDetail>,
        );
        setConvo(detail);
      }
    },
    [activeId, refreshConversations],
  );

  const deleteConversation = useCallback(
    async (id: string) => {
      if (!confirm("Delete this conversation? This removes all messages and logs.")) return;
      await fetch(`/api/conversations/${id}`, { method: "DELETE" });
      if (activeId === id) setActiveId(null);
      await refreshConversations();
    },
    [activeId, refreshConversations],
  );

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || isStreaming) return;
    let conversationId = activeId;
    if (!conversationId) {
      const res = await fetch("/api/conversations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, model }),
      });
      const created = (await res.json()) as ConversationSummary;
      conversationId = created.id;
      setActiveId(conversationId);
    }
    const userText = input;
    setInput("");
    setError(null);

    // Optimistic render of the user message.
    setConvo((prev) =>
      prev
        ? {
            ...prev,
            messages: [
              ...prev.messages,
              {
                id: `temp-${Date.now()}`,
                role: "USER",
                content: userText,
                createdAt: new Date().toISOString(),
              },
            ],
          }
        : prev,
    );

    setIsStreaming(true);
    setStreamingText("");
    const controller = new AbortController();
    abortRef.current = controller;

    let finalText = "";
    let streamRequestId: string | undefined;
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          conversationId,
          message: userText,
          provider,
          model,
        }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`HTTP ${res.status} ${await res.text().catch(() => "")}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE framing: events separated by \n\n
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const ev of events) {
          const line = ev.replace(/^data: /, "").trim();
          if (!line) continue;
          try {
            const payload = JSON.parse(line) as
              | { type: "meta"; requestId: string }
              | { type: "delta"; text: string }
              | { type: "done"; requestId: string }
              | { type: "error"; message: string };
            if (payload.type === "meta") {
              streamRequestId = payload.requestId;
            } else if (payload.type === "delta") {
              finalText += payload.text;
              setStreamingText(finalText);
            } else if (payload.type === "error") {
              setError(payload.message);
            }
          } catch {
            // skip non-JSON keepalives
          }
        }
      }
    } catch (err) {
      const e = err as Error;
      if (e.name !== "AbortError") setError(e.message);
    } finally {
      setIsStreaming(false);
      abortRef.current = null;
      // Re-fetch the canonical conversation (the server already persisted
      // the assistant message, and we want the inference metadata attached).
      const detail = await fetch(`/api/conversations/${conversationId}`).then(
        (r) => r.json() as Promise<ConversationDetail>,
      );
      setConvo(detail);
      setStreamingText("");
      await refreshConversations();
      // Suppress unused warning — kept for debugging.
      void streamRequestId;
    }
  }, [activeId, input, isStreaming, model, provider, refreshConversations]);

  const filteredModels = useMemo(() => models?.models ?? [], [models]);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[280px_1fr] h-[calc(100vh-7rem)]">
      <aside className="rounded-lg border border-ink-800 bg-ink-900/40 flex flex-col min-h-0">
        <div className="border-b border-ink-800 px-3 py-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-ink-200">Conversations</h2>
          <button
            onClick={createNewConversation}
            className="rounded bg-brand-600 px-2 py-1 text-xs font-medium text-white hover:bg-brand-700"
          >
            + New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {conversations === null && (
            <p className="px-3 py-4 text-xs text-ink-500">Loading…</p>
          )}
          {conversations?.length === 0 && (
            <p className="px-3 py-4 text-xs text-ink-500">No conversations yet. Start one →</p>
          )}
          {conversations?.map((c) => (
            <ConversationRow
              key={c.id}
              c={c}
              active={c.id === activeId}
              onOpen={() => setActiveId(c.id)}
              onCancel={() => cancelConversation(c.id)}
              onDelete={() => deleteConversation(c.id)}
            />
          ))}
        </div>
      </aside>

      <section className="rounded-lg border border-ink-800 bg-ink-900/40 flex flex-col min-h-0">
        <div className="border-b border-ink-800 px-4 py-3 flex flex-wrap items-center gap-3 justify-between">
          <div className="flex items-center gap-3">
            <div className="text-sm text-ink-300">
              {convo?.title ?? (convo ? `Conversation ${convo.id.slice(0, 8)}` : "New conversation")}
            </div>
            {convo && (
              <span
                className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                  convo.status === "ACTIVE"
                    ? "bg-brand-700/30 text-brand-500"
                    : convo.status === "CANCELLED"
                    ? "bg-amber-700/30 text-amber-400"
                    : "bg-ink-700/40 text-ink-400"
                }`}
              >
                {convo.status.toLowerCase()}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={`${provider}::${model}`}
              onChange={(e) => {
                const [p, m] = e.target.value.split("::");
                setProvider(p as ModelOption["provider"]);
                setModel(m);
              }}
              className="rounded border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-ink-100"
            >
              {filteredModels.map((m) => (
                <option key={`${m.provider}::${m.model}`} value={`${m.provider}::${m.model}`}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin px-4 py-4 space-y-4">
          {convo?.messages.length === 0 && !streamingText && (
            <div className="text-center text-ink-500 text-sm pt-12">
              <p className="mb-2">Start a conversation.</p>
              <p className="text-xs">
                Every call is logged with provider, model, latency, tokens, TTFT, and status — view
                them in the dashboard.
              </p>
            </div>
          )}
          {convo?.messages
            .filter((m) => m.role !== "SYSTEM")
            .map((m) => (
              <MessageBubble key={m.id} m={m} />
            ))}
          {isStreaming && (
            <MessageBubble
              m={{
                id: "streaming",
                role: "ASSISTANT",
                content: streamingText || "",
                createdAt: new Date().toISOString(),
              }}
              streaming
            />
          )}
        </div>

        {error && (
          <div className="border-t border-amber-700/40 bg-amber-900/30 px-4 py-2 text-xs text-amber-300">
            {error}
          </div>
        )}

        <div className="border-t border-ink-800 p-3">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void sendMessage();
                }
              }}
              rows={2}
              placeholder={
                convo?.status === "CANCELLED"
                  ? "Conversation cancelled. Start a new one to keep chatting."
                  : "Type a message. Enter to send, Shift+Enter for a new line."
              }
              disabled={convo?.status === "CANCELLED"}
              className="flex-1 resize-none rounded border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-50 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none disabled:opacity-60"
            />
            {isStreaming ? (
              <button
                onClick={stopStreaming}
                className="rounded bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-700"
              >
                Cancel
              </button>
            ) : (
              <button
                onClick={sendMessage}
                disabled={!input.trim() || convo?.status === "CANCELLED"}
                className="rounded bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-40"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function ConversationRow({
  c,
  active,
  onOpen,
  onCancel,
  onDelete,
}: {
  c: ConversationSummary;
  active: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`group border-b border-ink-800/50 px-3 py-2 cursor-pointer transition ${
        active ? "bg-ink-800/60" : "hover:bg-ink-800/30"
      }`}
      onClick={onOpen}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-ink-100">
            {c.title ?? `Conversation ${c.id.slice(0, 8)}`}
          </p>
          <p className="text-[10px] text-ink-500 mt-0.5">
            {c.provider} · {c.model} · {c._count.messages} msg
          </p>
        </div>
        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1">
          {c.status !== "CANCELLED" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
              title="Cancel"
              className="rounded p-1 text-amber-500 hover:bg-ink-700"
            >
              ◼
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            title="Delete"
            className="rounded p-1 text-ink-500 hover:bg-ink-700 hover:text-red-400"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ m, streaming }: { m: Message; streaming?: boolean }) {
  const isUser = m.role === "USER";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm leading-relaxed whitespace-pre-wrap ${
          isUser ? "bg-brand-600 text-white" : "bg-ink-800 text-ink-50"
        }`}
      >
        {m.content || (streaming ? <span className="pulse-dot">●</span> : "")}
        {!isUser && m.inferenceLog && <InferenceFooter meta={m.inferenceLog} />}
        {streaming && m.content && (
          <span className="ml-1 inline-block h-3 w-1.5 align-middle bg-ink-300 pulse-dot" />
        )}
      </div>
    </div>
  );
}

function InferenceFooter({ meta }: { meta: InferenceMeta }) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink-400">
      <span
        className={`rounded px-1.5 py-0.5 ${
          meta.status === "OK"
            ? "bg-brand-700/30 text-brand-500"
            : meta.status === "CANCELLED"
            ? "bg-amber-700/30 text-amber-400"
            : "bg-red-700/30 text-red-400"
        }`}
      >
        {meta.status.toLowerCase()}
      </span>
      <span>{meta.provider}/{meta.model}</span>
      <span>{meta.latencyMs}ms</span>
      {meta.ttftMs != null && <span>ttft {meta.ttftMs}ms</span>}
      <span>{meta.totalTokens} tok ({meta.promptTokens}↓ / {meta.completionTokens}↑)</span>
      {meta.errorMessage && <span className="text-red-400">{meta.errorMessage}</span>}
    </div>
  );
}
