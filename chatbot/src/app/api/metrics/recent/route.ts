import { NextResponse } from "next/server";
import { ingestion } from "@/lib/ingestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const data = await ingestion.recentLogs();
  return NextResponse.json(data);
}
