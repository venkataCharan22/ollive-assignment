import { NextRequest, NextResponse } from "next/server";
import { ingestion } from "@/lib/ingestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const updated = await ingestion.cancelConversation(id);
  return NextResponse.json(updated);
}
