import type { InferenceLog } from "./types";

/**
 * Log transport. Posts inference logs to the ingestion API.
 *
 * Design choices:
 *  - Fire-and-forget by default: the user-facing chat must not stall on
 *    observability. Failures are swallowed (and surfaced via `onError`)
 *    unless `failOpen: false` is set.
 *  - Small in-memory queue with a single flush worker. We deliberately do
 *    NOT add disk persistence here — that belongs in a sidecar agent if a
 *    deployment needs at-least-once guarantees from the edge. For an
 *    in-process SDK living next to a stateless web server, best-effort is
 *    the right tradeoff.
 *  - One retry with exponential backoff. The ingestion service is responsible
 *    for durability once it has the bytes; the SDK's job is just to hand off.
 */

export interface TransportOptions {
  url: string;
  apiKey: string;
  failOpen?: boolean;
  onError?: (err: Error, log: InferenceLog) => void;
  fetchImpl?: typeof fetch;
}

export class IngestionTransport {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly failOpen: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly onError: (err: Error, log: InferenceLog) => void;
  private inflight = new Set<Promise<void>>();

  constructor(opts: TransportOptions) {
    this.endpoint = opts.url.replace(/\/$/, "") + "/ingest/inference";
    this.apiKey = opts.apiKey;
    this.failOpen = opts.failOpen ?? true;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.onError =
      opts.onError ??
      ((err) => {
        // Default: log to stderr. A real deployment would route this to a
        // structured logger or a backup sink.
        // eslint-disable-next-line no-console
        console.warn("[ollive-sdk] log ship failed:", err.message);
      });
  }

  send(log: InferenceLog): void {
    const promise = this.dispatch(log).finally(() => {
      this.inflight.delete(promise);
    });
    this.inflight.add(promise);
  }

  /** Awaitable variant — useful in serverless where the process exits fast. */
  async sendAndWait(log: InferenceLog): Promise<void> {
    await this.dispatch(log);
  }

  /** Drain in-flight requests. Call before process exit in short-lived runtimes. */
  async flush(timeoutMs = 5000): Promise<void> {
    const all = Promise.all(Array.from(this.inflight));
    await Promise.race([
      all,
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private async dispatch(log: InferenceLog): Promise<void> {
    const body = JSON.stringify(log);
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const res = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-ollive-key": this.apiKey,
          },
          body,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
        }
        return;
      } catch (err) {
        lastErr = err as Error;
        // Small backoff before the single retry.
        if (attempt === 0) await new Promise((r) => setTimeout(r, 150));
      }
    }
    if (this.failOpen) {
      this.onError(lastErr!, log);
      return;
    }
    throw lastErr;
  }
}
