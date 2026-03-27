/**
 * Shared Upstash Redis client.
 * Requires KV_REST_API_URL and KV_REST_API_TOKEN in environment.
 * Run `vercel env pull` locally to sync these from your Vercel project.
 */

import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

export const KEYS = {
  pilotLog: "recycling:pilot-log",
  feedback: "recycling:feedback",
} as const;

/** Maximum entries to keep per list (oldest are trimmed automatically). */
export const MAX_ENTRIES = 10_000;
