import { NextRequest, NextResponse } from "next/server";
import { ingestion } from "@/lib/ingestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const hours = Number(req.nextUrl.searchParams.get("hours") ?? 24);
  const bucket = (req.nextUrl.searchParams.get("bucket") as "minute" | "hour") ?? "hour";
  const data = await ingestion.metricsTimeseries(hours, bucket);
  return NextResponse.json(data);
}
