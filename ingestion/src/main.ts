import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe, Logger } from "@nestjs/common";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );
  app.setGlobalPrefix("");
  const port = Number(process.env.INGESTION_PORT ?? 4000);
  await app.listen(port, "0.0.0.0");
  Logger.log(`Ollive ingestion listening on http://0.0.0.0:${port}`, "Bootstrap");
}

bootstrap();
