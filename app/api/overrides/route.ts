import { NextResponse } from "next/server";
import { z } from "zod/v4";
import { redis } from "@/lib/redis";
import type { ItemOverride, WasteStream } from "@/lib/types";

const OverrideSchema = z.object({
  pattern: z.string().min(1),
  stream: z.string().min(1),
  instruction: z.string().optional(),
  siteId: z.string().optional(),
});

function redisKey(siteId: string): string {
  return `recycling:dynamic-overrides:${siteId}`;
}

async function loadOverrides(siteId: string): Promise<ItemOverride[]> {
  const raw = await redis.get(redisKey(siteId));
  if (!raw) return [];
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as ItemOverride[];
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const parsed = OverrideSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body.", details: parsed.error.issues },
      { status: 400 }
    );
  }

  const siteId = parsed.data.siteId ?? "default";
  const newOverride: ItemOverride = {
    pattern: parsed.data.pattern,
    stream: parsed.data.stream as WasteStream,
    note: parsed.data.instruction,
  };

  try {
    const existing = await loadOverrides(siteId);

    // Deduplicate by pattern (case-insensitive)
    const filtered = existing.filter(
      (o) => o.pattern.toLowerCase() !== newOverride.pattern.toLowerCase()
    );
    filtered.push(newOverride);

    await redis.set(redisKey(siteId), JSON.stringify(filtered));

    return NextResponse.json(filtered);
  } catch (err) {
    console.error("[overrides] POST failed:", err);
    return NextResponse.json({ error: "Failed to save override." }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const siteId = searchParams.get("siteId") ?? "default";

  try {
    const overrides = await loadOverrides(siteId);
    return NextResponse.json(overrides);
  } catch (err) {
    console.error("[overrides] GET failed:", err);
    return NextResponse.json({ error: "Failed to load overrides." }, { status: 500 });
  }
}
