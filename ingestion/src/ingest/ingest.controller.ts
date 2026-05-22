import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ApiKeyGuard } from "../common/api-key.guard";
import { InferenceLogDto } from "./ingest.dto";
import { IngestService } from "./ingest.service";

@Controller("ingest")
@UseGuards(ApiKeyGuard)
export class IngestController {
  constructor(private readonly svc: IngestService) {}

  /**
   * Accept a single inference log from the SDK. Returns 202 Accepted: we've
   * durably queued the event on Redis Streams, the worker will persist it.
   * Synchronous DB write would couple the user-facing latency to Postgres
   * health, which is exactly what we want to avoid in a logging pipeline.
   */
  @Post("inference")
  @HttpCode(202)
  async ingestInference(@Body() body: InferenceLogDto) {
    const streamId = await this.svc.acceptInference(body);
    return { accepted: true, streamId };
  }
}
