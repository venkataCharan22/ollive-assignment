import { Module } from "@nestjs/common";
import { ConversationsController } from "./conversations.controller";
import { MetricsController } from "./metrics.controller";

@Module({
  controllers: [ConversationsController, MetricsController],
})
export class QueryModule {}
