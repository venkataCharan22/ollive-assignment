import { Provider, Logger } from "@nestjs/common";
import Redis from "ioredis";

export const REDIS = Symbol("REDIS");

export const RedisProvider: Provider = {
  provide: REDIS,
  useFactory: () => {
    const log = new Logger("Redis");
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    const client = new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    client.on("error", (err) => log.error(`redis error: ${err.message}`));
    client.on("connect", () => log.log(`connected to ${url}`));
    return client;
  },
};
