import { Inject, Injectable, Logger } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS } from "../common/redis.provider";
import { INFERENCE_STREAM } from "../common/stream.constants";
import type { InferenceLogDto } from "./ingest.dto";

/**
 * Publishes accepted inference logs onto the Redis Stream. We use Streams
 * (not pub/sub) so that:
 *   - if all workers are down, events still queue rather than disappearing,
 *   - we get a consumer-group abstraction for at-most-once dispatch with
 *     ack-or-redeliver semantics,
 *   - we get an offset cursor for free, useful for replay.
 *
 * MAXLEN ~ 100k caps memory. Events older than that get evicted; for a real
 * deployment, the worker has already persisted them to Postgres by then.
 */
@Injectable()
export class StreamProducerService {
  private readonly log = new Logger(StreamProducerService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async publish(event: InferenceLogDto): Promise<string> {
    // XADD with approximate trimming. The `~` makes it MAXLEN-ish, cheaper than exact.
    const id = await this.redis.xadd(
      INFERENCE_STREAM,
      "MAXLEN",
      "~",
      "100000",
      "*",
      "payload",
      JSON.stringify(event),
    );
    return id ?? "0-0";
  }
}
