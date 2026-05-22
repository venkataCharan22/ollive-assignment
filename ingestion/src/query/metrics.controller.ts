import { Controller, Get, Query } from "@nestjs/common";
import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";
import { Type } from "class-transformer";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

class MetricsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(168) hours?: number = 24;
  @IsOptional() @IsIn(["minute", "hour"]) bucket?: "minute" | "hour";
}

/**
 * Read-only metrics for the dashboard. Aggregations are computed live with
 * SQL window functions. At higher write volume you'd materialise these into
 * a time-series table (ClickHouse or a Postgres rollup) — for the assignment's
 * traffic profile, on-demand is fine and avoids the operational burden.
 */
@Controller("metrics")
export class MetricsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get("summary")
  async summary(@Query() q: MetricsQueryDto) {
    const since = new Date(Date.now() - (q.hours ?? 24) * 3600 * 1000);
    const rows = await this.prisma.$queryRaw<
      Array<{
        provider: string;
        total: bigint;
        ok: bigint;
        errors: bigint;
        cancelled: bigint;
        p50: number;
        p95: number;
        p99: number;
        avg_latency: number;
        avg_ttft: number | null;
        total_tokens: bigint;
      }>
    >(Prisma.sql`
      SELECT
        provider,
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE status = 'OK')::bigint AS ok,
        COUNT(*) FILTER (WHERE status = 'ERROR')::bigint AS errors,
        COUNT(*) FILTER (WHERE status = 'CANCELLED')::bigint AS cancelled,
        COALESCE(percentile_cont(0.5)  WITHIN GROUP (ORDER BY "latencyMs"), 0)::float AS p50,
        COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs"), 0)::float AS p95,
        COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY "latencyMs"), 0)::float AS p99,
        COALESCE(AVG("latencyMs"), 0)::float AS avg_latency,
        AVG("ttftMs")::float AS avg_ttft,
        COALESCE(SUM("totalTokens"), 0)::bigint AS total_tokens
      FROM "InferenceLog"
      WHERE "startedAt" >= ${since}
      GROUP BY provider
      ORDER BY provider
    `);

    const totals = await this.prisma.$queryRaw<
      Array<{
        total: bigint;
        ok: bigint;
        errors: bigint;
        cancelled: bigint;
        p50: number;
        p95: number;
        p99: number;
        avg_latency: number;
        avg_ttft: number | null;
        total_tokens: bigint;
      }>
    >(Prisma.sql`
      SELECT
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE status = 'OK')::bigint AS ok,
        COUNT(*) FILTER (WHERE status = 'ERROR')::bigint AS errors,
        COUNT(*) FILTER (WHERE status = 'CANCELLED')::bigint AS cancelled,
        COALESCE(percentile_cont(0.5)  WITHIN GROUP (ORDER BY "latencyMs"), 0)::float AS p50,
        COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs"), 0)::float AS p95,
        COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY "latencyMs"), 0)::float AS p99,
        COALESCE(AVG("latencyMs"), 0)::float AS avg_latency,
        AVG("ttftMs")::float AS avg_ttft,
        COALESCE(SUM("totalTokens"), 0)::bigint AS total_tokens
      FROM "InferenceLog"
      WHERE "startedAt" >= ${since}
    `);

    return {
      since: since.toISOString(),
      hours: q.hours ?? 24,
      overall: serialiseRow(totals[0]),
      byProvider: rows.map(serialiseRow),
    };
  }

  @Get("timeseries")
  async timeseries(@Query() q: MetricsQueryDto) {
    const since = new Date(Date.now() - (q.hours ?? 24) * 3600 * 1000);
    const truncTo = q.bucket === "minute" ? "minute" : "hour";

    const rows = await this.prisma.$queryRaw<
      Array<{
        bucket: Date;
        provider: string;
        total: bigint;
        errors: bigint;
        p50: number;
        p95: number;
        avg_latency: number;
        total_tokens: bigint;
      }>
    >(Prisma.sql`
      SELECT
        date_trunc(${truncTo}, "startedAt") AS bucket,
        provider,
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE status = 'ERROR')::bigint AS errors,
        COALESCE(percentile_cont(0.5)  WITHIN GROUP (ORDER BY "latencyMs"), 0)::float AS p50,
        COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs"), 0)::float AS p95,
        COALESCE(AVG("latencyMs"), 0)::float AS avg_latency,
        COALESCE(SUM("totalTokens"), 0)::bigint AS total_tokens
      FROM "InferenceLog"
      WHERE "startedAt" >= ${since}
      GROUP BY bucket, provider
      ORDER BY bucket ASC
    `);

    return {
      since: since.toISOString(),
      bucket: truncTo,
      points: rows.map((r) => ({
        bucket: r.bucket.toISOString(),
        provider: r.provider,
        total: Number(r.total),
        errors: Number(r.errors),
        p50: r.p50,
        p95: r.p95,
        avgLatency: r.avg_latency,
        totalTokens: Number(r.total_tokens),
      })),
    };
  }

  @Get("recent")
  async recent(@Query() q: MetricsQueryDto) {
    return this.prisma.inferenceLog.findMany({
      orderBy: { startedAt: "desc" },
      take: 50,
      select: {
        id: true,
        conversationId: true,
        provider: true,
        model: true,
        status: true,
        startedAt: true,
        latencyMs: true,
        ttftMs: true,
        streamed: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        inputPreview: true,
        outputPreview: true,
        errorMessage: true,
      },
    });
  }
}

function serialiseRow<T extends Record<string, unknown>>(row: T | undefined) {
  if (!row) {
    return {
      total: 0,
      ok: 0,
      errors: 0,
      cancelled: 0,
      p50: 0,
      p95: 0,
      p99: 0,
      avgLatency: 0,
      avgTtft: null,
      totalTokens: 0,
    };
  }
  return {
    provider: (row as Record<string, unknown>).provider,
    total: Number(row.total ?? 0),
    ok: Number(row.ok ?? 0),
    errors: Number(row.errors ?? 0),
    cancelled: Number(row.cancelled ?? 0),
    p50: Number(row.p50 ?? 0),
    p95: Number(row.p95 ?? 0),
    p99: Number(row.p99 ?? 0),
    avgLatency: Number(row.avg_latency ?? 0),
    avgTtft: row.avg_ttft == null ? null : Number(row.avg_ttft),
    totalTokens: Number(row.total_tokens ?? 0),
  };
}
