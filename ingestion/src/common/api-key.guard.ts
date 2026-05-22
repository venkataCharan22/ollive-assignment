import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";

/**
 * Shared-secret check for the /ingest/* endpoints. The SDK sends X-Ollive-Key
 * with the value configured as INGESTION_API_KEY. A real deployment would
 * rotate this and scope keys per tenant; for the assignment, one key is fine.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const expected = process.env.INGESTION_API_KEY;
    if (!expected) {
      // Fail closed if the env var is unset — otherwise the endpoint would be open.
      throw new UnauthorizedException("INGESTION_API_KEY is not configured");
    }
    const got = req.header("x-ollive-key");
    if (got !== expected) {
      throw new UnauthorizedException("invalid or missing X-Ollive-Key");
    }
    return true;
  }
}
