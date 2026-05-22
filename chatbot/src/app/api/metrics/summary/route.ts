import { NextRequest, NextResponse } from "next/server";
import { ingestion } from "@/lib/ingestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const hours = Number(req.nextUrl.searchParams.get("hours") ?? 24);
  const data = await ingestion.metricsSummary(hours);
  return NextResponse.json(data);
}
