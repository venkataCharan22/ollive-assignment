"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface SummaryRow {
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

interface SummaryResp {
  since: string;
  hours: number;
  overall: SummaryRow;
  byProvider: SummaryRow[];
}

interface TimeseriesResp {
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
}

interface RecentLog {
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
}

const PROVIDER_COLORS: Record<string, string> = {
  openai: "#10b981",
  anthropic: "#f59e0b",
  google: "#3b82f6",
  mock: "#a78bfa",
};

/**
 * Observability dashboard. Polls every 5s so reviewers see numbers move while
 * they use the chat. The shape mirrors what an on-call engineer would want
 * at a glance: latency percentiles, throughput, errors, token usage.
 */
export default function Dashboard() {
  const [hours, setHours] = useState(24);
  const [summary, setSummary] = useState<SummaryResp | null>(null);
  const [series, setSeries] = useState<TimeseriesResp | null>(null);
  const [recent, setRecent] = useState<RecentLog[]>([]);
  const [tab, setTab] = useState<"latency" | "throughput" | "errors" | "tokens">("latency");

  const reload = useCallback(async () => {
    const [s, t, r] = await Promise.all([
      fetch(`/api/metrics/summary?hours=${hours}`).then((r) => r.json() as Promise<SummaryResp>),
      fetch(`/api/metrics/timeseries?hours=${hours}&bucket=${hours <= 6 ? "minute" : "hour"}`).then(
        (r) => r.json() as Promise<TimeseriesResp>,
      ),
      fetch(`/api/metrics/recent`).then((r) => r.json() as Promise<RecentLog[]>),
    ]);
    setSummary(s);
    setSeries(t);
    setRecent(r);
  }, [hours]);

  useEffect(() => {
    void reload();
    const id = setInterval(() => void reload(), 5000);
    return () => clearInterval(id);
  }, [reload]);

  const seriesByBucket = useMemo(() => {
    if (!series) return [];
    // Pivot rows so each bucket has columns per provider.
    const buckets = new Map<string, Record<string, number | string>>();
    for (const p of series.points) {
      const row = buckets.get(p.bucket) ?? { bucket: p.bucket };
      row[`${p.provider}_p95`] = p.p95;
      row[`${p.provider}_p50`] = p.p50;
      row[`${p.provider}_total`] = p.total;
      row[`${p.provider}_errors`] = p.errors;
      row[`${p.provider}_tokens`] = p.totalTokens;
      buckets.set(p.bucket, row);
    }
    return Array.from(buckets.values()).sort((a, b) =>
      String(a.bucket).localeCompare(String(b.bucket)),
    );
  }, [series]);

  const providers = useMemo(() => {
    const set = new Set<string>();
    series?.points.forEach((p) => set.add(p.provider));
    summary?.byProvider.forEach((p) => p.provider && set.add(p.provider));
    return Array.from(set).sort();
  }, [series, summary]);

  const errorRate = (row: SummaryRow) => (row.total === 0 ? 0 : (row.errors / row.total) * 100);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Inference observability</h1>
          <p className="text-xs text-ink-400 mt-1">
            Auto-refreshes every 5 seconds · since{" "}
            {summary ? new Date(summary.since).toLocaleString() : "—"}
          </p>
        </div>
        <select
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
          className="rounded border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-ink-100"
        >
          <option value={1}>Last 1h</option>
          <option value={6}>Last 6h</option>
          <option value={24}>Last 24h</option>
          <option value={168}>Last 7d</option>
        </select>
      </div>

      {summary && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Requests" value={summary.overall.total.toLocaleString()} />
          <Stat
            label="Error rate"
            value={`${errorRate(summary.overall).toFixed(1)}%`}
            tone={errorRate(summary.overall) > 5 ? "warn" : "ok"}
          />
          <Stat label="p95 latency" value={`${Math.round(summary.overall.p95)}ms`} />
          <Stat label="Total tokens" value={summary.overall.totalTokens.toLocaleString()} />
        </div>
      )}

      <div className="rounded-lg border border-ink-800 bg-ink-900/40">
        <div className="border-b border-ink-800 px-4 py-2 flex items-center gap-1">
          <TabBtn active={tab === "latency"} onClick={() => setTab("latency")}>Latency</TabBtn>
          <TabBtn active={tab === "throughput"} onClick={() => setTab("throughput")}>Throughput</TabBtn>
          <TabBtn active={tab === "errors"} onClick={() => setTab("errors")}>Errors</TabBtn>
          <TabBtn active={tab === "tokens"} onClick={() => setTab("tokens")}>Tokens</TabBtn>
        </div>
        <div className="px-4 py-4 h-72">
          <ResponsiveContainer width="100%" height="100%">
            {tab === "latency" ? (
              <LineChart data={seriesByBucket}>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                <XAxis dataKey="bucket" tickFormatter={fmtTick} stroke="#71717a" fontSize={11} />
                <YAxis stroke="#71717a" fontSize={11} unit="ms" />
                <Tooltip contentStyle={tooltipStyle} labelFormatter={(v) => new Date(v as string).toLocaleString()} />
                <Legend />
                {providers.map((p) => (
                  <Line
                    key={p}
                    type="monotone"
                    dataKey={`${p}_p95`}
                    name={`${p} p95`}
                    stroke={PROVIDER_COLORS[p] ?? "#fff"}
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            ) : tab === "throughput" ? (
              <BarChart data={seriesByBucket}>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                <XAxis dataKey="bucket" tickFormatter={fmtTick} stroke="#71717a" fontSize={11} />
                <YAxis stroke="#71717a" fontSize={11} />
                <Tooltip contentStyle={tooltipStyle} labelFormatter={(v) => new Date(v as string).toLocaleString()} />
                <Legend />
                {providers.map((p) => (
                  <Bar
                    key={p}
                    dataKey={`${p}_total`}
                    name={p}
                    stackId="t"
                    fill={PROVIDER_COLORS[p] ?? "#fff"}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            ) : tab === "errors" ? (
              <AreaChart data={seriesByBucket}>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                <XAxis dataKey="bucket" tickFormatter={fmtTick} stroke="#71717a" fontSize={11} />
                <YAxis stroke="#71717a" fontSize={11} />
                <Tooltip contentStyle={tooltipStyle} labelFormatter={(v) => new Date(v as string).toLocaleString()} />
                <Legend />
                {providers.map((p) => (
                  <Area
                    key={p}
                    type="monotone"
                    dataKey={`${p}_errors`}
                    name={p}
                    stackId="e"
                    stroke={PROVIDER_COLORS[p] ?? "#fff"}
                    fill={PROVIDER_COLORS[p] ?? "#fff"}
                    fillOpacity={0.25}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            ) : (
              <BarChart data={seriesByBucket}>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                <XAxis dataKey="bucket" tickFormatter={fmtTick} stroke="#71717a" fontSize={11} />
                <YAxis stroke="#71717a" fontSize={11} />
                <Tooltip contentStyle={tooltipStyle} labelFormatter={(v) => new Date(v as string).toLocaleString()} />
                <Legend />
                {providers.map((p) => (
                  <Bar
                    key={p}
                    dataKey={`${p}_tokens`}
                    name={p}
                    stackId="tok"
                    fill={PROVIDER_COLORS[p] ?? "#fff"}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-ink-800 bg-ink-900/40">
          <div className="border-b border-ink-800 px-4 py-2 text-sm font-medium text-ink-200">
            By provider
          </div>
          <div className="divide-y divide-ink-800/60">
            {summary?.byProvider.length === 0 && (
              <p className="px-4 py-6 text-xs text-ink-500">No requests in the selected window.</p>
            )}
            {summary?.byProvider.map((p) => (
              <div key={p.provider} className="px-4 py-3 grid grid-cols-6 items-center gap-2 text-xs">
                <div className="col-span-2 flex items-center gap-2">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: PROVIDER_COLORS[p.provider ?? "mock"] }}
                  />
                  <span className="font-medium text-ink-100">{p.provider}</span>
                </div>
                <div className="text-ink-300">{p.total} req</div>
                <div className={errorRate(p) > 5 ? "text-amber-400" : "text-ink-300"}>
                  {errorRate(p).toFixed(1)}% err
                </div>
                <div className="text-ink-300">p95 {Math.round(p.p95)}ms</div>
                <div className="text-ink-400">{(p.totalTokens / 1000).toFixed(1)}k tok</div>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-ink-800 bg-ink-900/40">
          <div className="border-b border-ink-800 px-4 py-2 text-sm font-medium text-ink-200">
            Recent calls
          </div>
          <div className="max-h-96 overflow-y-auto scrollbar-thin divide-y divide-ink-800/60">
            {recent.length === 0 && (
              <p className="px-4 py-6 text-xs text-ink-500">Nothing logged yet.</p>
            )}
            {recent.map((r) => (
              <div key={r.id} className="px-4 py-3 text-xs">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] ${
                        r.status === "OK"
                          ? "bg-brand-700/30 text-brand-500"
                          : r.status === "CANCELLED"
                          ? "bg-amber-700/30 text-amber-400"
                          : "bg-red-700/30 text-red-400"
                      }`}
                    >
                      {r.status.toLowerCase()}
                    </span>
                    <span className="text-ink-200">{r.provider}/{r.model}</span>
                  </div>
                  <span className="text-ink-500">{new Date(r.startedAt).toLocaleTimeString()}</span>
                </div>
                <p className="text-ink-400 truncate">→ {r.inputPreview || "(empty)"}</p>
                <p className="text-ink-300 truncate">← {r.outputPreview || r.errorMessage || "(no output)"}</p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-ink-500">
                  <span>{r.latencyMs}ms</span>
                  {r.ttftMs != null && <span>ttft {r.ttftMs}ms</span>}
                  <span>{r.totalTokens} tok</span>
                  {r.streamed && <span>streamed</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" }) {
  return (
    <div
      className={`rounded-lg border bg-ink-900/40 px-4 py-3 ${
        tone === "warn" ? "border-amber-700/50" : "border-ink-800"
      }`}
    >
      <p className="text-[10px] uppercase tracking-wider text-ink-400">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${tone === "warn" ? "text-amber-400" : "text-ink-50"}`}>
        {value}
      </p>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-3 py-1 text-xs font-medium transition ${
        active ? "bg-ink-800 text-ink-50" : "text-ink-400 hover:bg-ink-800/50 hover:text-ink-100"
      }`}
    >
      {children}
    </button>
  );
}

const tooltipStyle = {
  background: "#18181b",
  border: "1px solid #27272a",
  borderRadius: 6,
  fontSize: 11,
};

function fmtTick(value: string): string {
  const d = new Date(value);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
