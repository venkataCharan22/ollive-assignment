import { Injectable, Logger } from "@nestjs/common";
import { StreamProducerService } from "./stream-producer.service";
import type { InferenceLogDto } from "./ingest.dto";

@Injectable()
export class IngestService {
  private readonly log = new Logger(IngestService.name);

  constructor(private readonly producer: StreamProducerService) {}

  async acceptInference(payload: InferenceLogDto): Promise<string> {
    const id = await this.producer.publish(payload);
    // Keep this log line cheap — it's on the hot path.
    this.log.debug(
      `accepted req=${payload.requestId} conv=${payload.conversationId} provider=${payload.provider} status=${payload.status}`,
    );
    return id;
  }
}
