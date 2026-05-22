import { NextRequest, NextResponse } from "next/server";
import { ingestion, type ConvoStatus } from "@/lib/ingestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const status = (req.nextUrl.searchParams.get("status") as ConvoStatus | null) ?? undefined;
  const items = await ingestion.listConversations(status);
  return NextResponse.json(items);
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { title?: string; provider: string; model: string };
  const created = await ingestion.createConversation(body);
  return NextResponse.json(created, { status: 201 });
}
