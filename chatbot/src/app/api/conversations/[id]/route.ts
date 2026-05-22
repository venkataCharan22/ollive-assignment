import { NextRequest, NextResponse } from "next/server";
import { ingestion } from "@/lib/ingestion";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const convo = await ingestion.getConversation(id);
  return NextResponse.json(convo);
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json();
  const updated = await ingestion.updateConversation(id, body);
  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  await ingestion.deleteConversation(id);
  return new NextResponse(null, { status: 204 });
}
