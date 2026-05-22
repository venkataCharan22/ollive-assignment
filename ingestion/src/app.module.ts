import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { IngestModule } from "./ingest/ingest.module";
import { QueryModule } from "./query/query.module";
import { WorkerModule } from "./worker/worker.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [PrismaModule, IngestModule, QueryModule, WorkerModule],
  controllers: [HealthController],
})
export class AppModule {}
