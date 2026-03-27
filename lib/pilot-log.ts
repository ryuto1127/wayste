/**
 * Lightweight structured logging for pilot evaluation.
 * Appends JSONL to data/pilot-log.jsonl.
 */

import { appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { PilotLogEntry } from "./types";

const LOG_PATH = join(process.cwd(), "data", "pilot-log.jsonl");

export function logPilotEntry(entry: PilotLogEntry): void {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n");
  } catch {
    // best-effort — never block the response
  }
}
