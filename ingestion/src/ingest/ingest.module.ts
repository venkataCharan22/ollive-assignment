import { Module } from "@nestjs/common";
import { IngestController } from "./ingest.controller";
import { IngestService } from "./ingest.service";
import { StreamProducerService } from "./stream-producer.service";
import { RedisProvider } from "../common/redis.provider";

@Module({
  controllers: [IngestController],
  providers: [IngestService, StreamProducerService, RedisProvider],
  exports: [StreamProducerService, RedisProvider],
})
export class IngestModule {}
