import { NextResponse } from "next/server";
import { analyzeFeedback } from "@/lib/feedback-analysis";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const siteId = searchParams.get("siteId") ?? undefined;

  const stats = await analyzeFeedback(siteId);
  return NextResponse.json(stats);
}
