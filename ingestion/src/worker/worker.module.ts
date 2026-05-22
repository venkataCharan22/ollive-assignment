import { Module } from "@nestjs/common";
import { StreamConsumerService } from "./stream-consumer.service";
import { RedisProvider } from "../common/redis.provider";

@Module({
  providers: [StreamConsumerService, RedisProvider],
})
export class WorkerModule {}
