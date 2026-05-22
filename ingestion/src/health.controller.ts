import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "./prisma/prisma.service";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async health() {
    let db = "ok";
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      db = (err as Error).message;
    }
    return {
      status: "ok",
      service: "ollive-ingestion",
      db,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
