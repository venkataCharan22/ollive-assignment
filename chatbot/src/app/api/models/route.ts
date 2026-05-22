import { NextResponse } from "next/server";
import { availableModels } from "@/lib/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    models: availableModels(),
    defaultProvider: process.env.DEFAULT_PROVIDER ?? "mock",
    defaultModel: process.env.DEFAULT_MODEL ?? "mock-fast",
  });
}
