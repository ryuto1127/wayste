## Communication Style
- Match the language you use (English or Japanese)
- Avoid technical jargon; use plain, natural language
- If technical terms or concepts come up, explain what they mean in simple terms
- **Project name spelling: always lowercase `wayste`** — never `Wayste`, `WAYSTE`, or `WaYsTe`. This applies even at the start of a sentence and in headings/titles. The name is a stylized lowercase wordmark.

### Kiosk End-Users (Office/Airport Workers)
- The kiosk's UI must also use simple, non-technical language
- Every screen, button label, and message should be clear to someone with no waste-sorting knowledge
- Avoid ambiguity; assume users glance for ~2 seconds and move on

## Project Vision
- AI waste sorting kiosk: fixed downward camera near bins detects items and displays the correct bin on screen in real-time
- End goal: zero-effort sorting guidance in offices, airports, and public spaces
- Constraints: browser-first inference (minimize server costs/latency); camera sees only waste + hands, never faces
- Current phase: demo on Vercel, no production deployment yet — planning pilot tests
- Roadmap (privacy): move to 100% on-device inference — introduce a local VLM as "Tier 1.5" for items YOLO can't resolve, keep `gpt-5.4-mini` as a temporary safety net, then remove the cloud path once the local VLM clears accuracy/latency bars. End state: no image ever leaves the device.

## Tech Stack
- TypeScript / Next.js 16 (App Router) / React 19 / Tailwind CSS v4
- YOLO26m FP16 (ONNX Runtime Web) — browser object detection, 15 custom waste classes (`15class_v1.onnx`, 39 MB)
- OpenAI `gpt-5.4-mini` — cloud fallback (single-model path) when local YOLO confidence is below the fallback threshold
- Upstash Redis (REST) / Vercel Blob / Vercel Serverless + Cron
- Zod v4 / Jest v30 (465 tests, 19 suites) / EN+JA i18n (174 keys/locale)

## Commands
    npm run dev      # Dev server (Turbopack)
    npm run build    # Production build
    npm test         # 465 Jest tests, 19 suites
    npm run lint     # ESLint

## Routes
- `/` — Public marketing landing page (`app/page.tsx`); 10-section product introduction with embedded demos. Light theme, scrollable.
- `/kiosk` — Kiosk display for physical devices (`app/kiosk/page.tsx`); requires valid `kiosk_session` cookie or middleware redirects to `/kiosk/unlock`. Wrapped in dark fixed-viewport layout via `app/kiosk/layout.tsx`.
- `/kiosk/unlock` — One-time kiosk auth flow; sets the long-lived `kiosk_session` cookie then redirects to `/kiosk`.
- `/review`, `/insights` — Admin pages, gated by HTTP Basic Auth via middleware.

## Architecture
- `app/api/classify/route.ts` — Classification endpoint (GPT-5.4 mini, overrides, Blob upload); supports single + batch (up to 4 items) formats
- `lib/threshold-config.ts` — Master sensitivity (0–1) → all detection/inference thresholds; auto-calibration aware
- `lib/frame-analyzer.ts` — CV pipeline: 120x120 canvas, ~33fps, background subtraction, auto-calibration, multi-blob detection (top 4 with per-blob sharpness/contrast/skin/saturation scoring)
- `lib/yolo-inference.ts` — YOLO26m wrapper (Tier 1: 15 custom waste classes; instant result when confidence ≥ YOLO_FALLBACK_THRESHOLD = 0.725 at default sensitivity, derived as `lerp(0.80, 0.65, sensitivity)` in `lib/threshold-config.ts`); WebGPU primary, WASM fallback
- `lib/rgb-material-analyzer.ts` — RGB/texture analysis helpers (HSV color, transparency, metallicity, bbox aspect ratio, LBP texture, class-name refinement). The classify route *can* accept a `MaterialHint` and fold it into the GPT prompt + log, but the live kiosk path does not currently produce one — `analyzeMaterial()` is unwired and `KioskDisplay` sends no hint; only `refineClassName` / `computeLbpTexture` / `detectMetallicFromLuminance` are unit-tested. Treat this module as scaffolding, not an active stage.
- `lib/inference-backend.ts` — 2-tier orchestration (YOLO → GPT-5.4 mini); sequential model startup with `overallReady` gate
- `lib/vlm-shadow.ts` — Cloud-vs-local shadow comparison (pilot mechanism, off by default). When `LOCAL_VLM_ENDPOINT` is set, `/api/classify` also runs a local/candidate VLM on each escalated frame (server-side, non-blocking, inside the existing background logging) and records `localModel` on the pilot-log entry; aggregated by `computeModelComparison()` and shown on `/insights`. Offline benchmarking harness lives in `lib/benchmark/` (+ `scripts/bench/`)
- `lib/waste-rules-core.ts` — Word-boundary pattern matching + override engine (browser-safe)
- `lib/waste-rules.ts` — Site config loader + GPT prompt builder (5-min cache)
- `components/KioskDisplay.tsx` — State machine: loading → idle → object_detected → classifying → result → cooldown; multi-item blob-to-detection matching (up to 4), three-way routing (YOLO match above threshold → instant result, YOLO match below threshold → GPT-5.4 mini, unmatched+object → GPT-5.4 mini, unmatched+noise → discard)
- `config/sites/*.json` — Per-site waste rules (4 presets: japan-office, office-hq, airport, pilot; japan-office is the default)
- `middleware.ts` — Admin auth (HTTP Basic Auth → 4-hour session cookie), kiosk session gate on `/kiosk` and `/kiosk/unlock`, and per-request nonce-based CSP

## Rules & Conventions
- 2-tier local-first: always prefer browser YOLO over API; only fall back to OpenAI `gpt-5.4-mini` when local confidence is insufficient
- Overrides use word-boundary matching ("cup" matches "paper cup" but not "cupcake")
- `staffHandlingItems` force `needs_review` regardless of AI output
- Image uploads and Redis logging run via `waitUntil()` — never block the response
- i18n keys live in `lib/i18n.ts`; API accepts `locale` param for response language
- Site configs are JSON-only — no code changes needed to add/modify waste rules
- Admin sessions: SHA-256(ADMIN_API_KEY + salt), 4h cookie TTL — rotate `ADMIN_API_KEY` to invalidate all sessions
- Kiosk sessions: HMAC-SHA256 keyed by `KIOSK_API_TOKEN` → HttpOnly `kiosk_session` cookie (30d). Unlock via `POST /api/kiosk/session` with `Authorization: Bearer <KIOSK_API_TOKEN>` or via the `/kiosk/unlock` UI. See `lib/kiosk-auth.ts`.
- Blob URL allow-listing: every `fetch()` of a Vercel Blob URL goes through `isAllowedBlobUrl()` which requires hostname to match `BLOB_STORE_HOST` exactly — prevents `BLOB_READ_WRITE_TOKEN` being sent to an attacker-controlled store via a planted log entry.

## Design Rationale
- Users walk up holding trash — there is no "place item on surface" step; the system must classify within seconds of approach → speed-first pipeline design
- Local-first for three reasons: cost, latency, **and privacy** — frames never leave the browser
- UX is optimized for "glance and go": show the correct bin instantly, hide details behind a collapsible tap; too much info causes confusion
- No end-user feedback loop at the kiosk — relying on a Wrong button in the field proved unreliable, so it was removed. All quality evaluation comes through the admin `/review` dashboard only (single source of truth).
- YOLO inference is on-demand, not a continuous loop — lightweight CV runs at ~33fps, heavy inference fires only when object + quality gates pass
- Result screen stays until the item disappears from view — no auto-dismiss timeout; users need time to read the result before walking away
- All detection thresholds derive from `sensitivity` in site config via `lib/threshold-config.ts` — never hardcode individual thresholds; change sensitivity or the derivation formula instead
- Auto-calibration during BG settling overrides ROI_FG_THRESHOLD with environment-specific noise floor; always test with both calibrated and uncalibrated paths
- No user-facing settings on the kiosk — language/voice/etc. live in `config/sites/*.json`. Toggles conflict with the 2-second glance assumption and create inconsistent state across users.

## Do NOT
- Skip reading `node_modules/next/dist/docs/` before using Next.js 16 APIs — breaking changes from training data
- Hardcode waste rules in code — use `config/sites/*.json`
- Import Node built-ins (`fs`, `path`, `crypto`) in browser code — they are stubbed to empty modules
- Send every frame to the API — the CV pipeline gates classification (ROI + sharpness + skin checks)
- Use Edge Functions (deprecated) or `NEXT_PUBLIC_*` for secrets

## Self-Updating Rules

This file is a living document of intent, not just facts.
It should capture not only technical facts but also *what this product is for* and *why it is built this way* —
these guide every implementation decision as much as the code itself.

When working on this project, proactively suggest updates when you observe:
- A shift or refinement in product direction or target use case (→ Project Vision)
- A UX or product decision that reveals a new "why" (→ Design Rationale)
- A tradeoff that was made and the reasoning behind it (→ Design Rationale)
- A mistake or anti-pattern encountered (→ Do NOT)
- A new constraint, command, or architectural fact (→ relevant section)
- A concept or principle that doesn't fit any existing section (→ propose a new section)

When suggesting an update:
1. Identify which existing section it belongs to, or propose a new section if none fits
2. Show the exact diff against the current content
3. Ask: "Should I add this to CLAUDE.md?"
4. Only write after explicit confirmation
