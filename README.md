# Recycling Buddy Kiosk

A real-time AI-powered waste sorting kiosk. Hold any item in front of the camera and it tells you which bin it belongs in — no app, no phone, no buttons required.

Built for office and public-space pilots, with full English and Japanese support. Configurable per-site waste streams, pre-disposal guidance, and bias-aware computer vision.

---

## What it does

- Detects objects held up to the camera using local computer vision — no cloud needed for detection
- Runs a **3-tier local inference pipeline** entirely in the browser before touching any cloud API:
  - **Tier 1 — YOLO26m (on-demand):** runs when the CV pipeline triggers classification; COCO-80 items with high confidence are resolved instantly (no server call)
  - **Tier 2 — YOLO World S (on-demand):** 23 consolidated recycling-specific classes (metal cans, cardboard, napkins, styrofoam, straws, etc.) that COCO-80 misses; loaded lazily (47.9 MB) and run when Tier 1 confidence is below 0.65
  - **Tier 3 — OpenAI API:** last resort when both local models fail or confidence stays below 0.30
- **YOLO26m covers all 80 COCO classes** — non-waste detections (person, car, furniture, animals) resolve to `not_waste` and return `nothing_detected` instantly, skipping YOLO World and the API entirely
- When Tier 1 confidence is below 0.30, the API fires in parallel with YOLO World so the slower path never adds extra latency
- Shows a **clear directive** based on confidence level — no raw percentages shown to users:
  - High confidence → **"Put this in Recycling"**
  - Medium confidence → **"This looks like it goes in Landfill"** + a soft note to check the bin label
  - Low confidence → best guess with **"When in doubt, use Landfill"** fallback
- Shows **pre-disposal guidance** when needed (e.g. "Empty contents and remove cap") before the bin directive
- Supports **English and Japanese** with configurable default locale per site
- Lets users tap **Correct / Wrong** to give feedback — the "Wrong" correction menu dynamically shows the site's configured streams
- Logs every scan and all feedback to Redis for post-pilot analysis
- Saves captured images to **Vercel Blob** with public access + random-suffix URLs (non-guessable, non-enumerable); only exposed through admin-authenticated routes
- Automatically archives pilot data to Blob and purges old images via a daily cron job

---

## How to use it

1. Open the kiosk URL on any device with a camera
2. Hold one item in front of the camera
3. Wait for the result — instant for common items (YOLO26m), ~200–800 ms for recycling-specific items (YOLO World), or 1–3 seconds (API fallback)
4. Dispose of the item in the indicated bin
5. Optionally tap **Correct** or **Wrong** to give feedback

---

## Pages

| URL | Purpose |
|-----|---------|
| `/` | The kiosk itself |
| `/dashboard` | Live accuracy stats, most-corrected items |
| `/review` | Human review — browse all classifications, mark each as Correct/Wrong/Nothing (false detection), download ZIP of flagged images for annotation |

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, TypeScript) |
| Styling | Tailwind CSS v4 |
| Local inference (Tier 1) | YOLO26m FP16 (COCO-80, 39 MB) via ONNX Runtime Web — on-demand |
| Local inference (Tier 2) | YOLO World S (23 consolidated recycling classes, 47.9 MB) via ONNX Runtime Web — on-demand fallback |
| AI classification | OpenAI GPT-5.4 vision — nano (fast) with mini escalation (accurate) |
| Local detection | OffscreenCanvas background subtraction at 120×120 (square), ~33 fps, HSV-based skin filtering |
| Response validation | Zod schema validation on all model output |
| API security | HMAC-signed session tokens + two-tier auth (kiosk token / admin key) |
| Database | Upstash Redis (pilot logs + feedback) |
| Image storage | Vercel Blob (captured frames, daily JSONL archives) |
| Hosting | Vercel |

---

## Local development

### Prerequisites

- Node.js 18+
- An OpenAI account with API credits
- A webcam

### Install and run

```bash
git clone https://github.com/ryuto1127/recycling-buddy-kiosk.git
cd recycling-buddy-kiosk
npm install
```

Create `.env.local`:

```env
OPENAI_API_KEY=sk-...
```

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and allow camera access when prompted.

> **Camera mirroring:** By default the video feed is **not mirrored** — this is correct for a fixed kiosk camera facing outward (text on packages reads normally). If you are testing on a laptop with a front-facing selfie camera, add `NEXT_PUBLIC_MIRROR_CAMERA=true` to `.env.local` to flip the feed.

---

## Deployment

### 1. Push to GitHub and deploy to Vercel

```bash
vercel --prod
```

Or connect the GitHub repo to Vercel for automatic deploys on every `git push`.

### 2. Add storage

```bash
# Redis — stores pilot logs and user feedback
vercel integration add upstash
```

For Blob (image storage), go to **Vercel dashboard → Storage → Create Database → Blob**.

### 3. Sync env vars locally

```bash
vercel env pull
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | Your OpenAI API key |
| `KV_REST_API_URL` | Production | Upstash Redis REST URL |
| `KV_REST_API_TOKEN` | Production | Upstash Redis token |
| `BLOB_READ_WRITE_TOKEN` | Production | Vercel Blob token |
| `SITE_ID` | No | Site config to load (default: `default`). The site config's `defaultLocale` sets the UI language. |
| `BLOB_ENABLED` | No | Set to `false` to disable all image uploads entirely (default: enabled). |
| `NEXT_PUBLIC_MIRROR_CAMERA` | No | Set to `true` for front-facing / selfie cameras. Omit or set `false` for outward-facing kiosk cameras. |
| `RATE_LIMIT_MAX` | No | Max classifications per IP per minute (default: `15`) |
| `KIOSK_API_TOKEN` | No | Bearer token required by kiosk endpoints (classify, feedback, pilot-log). Omit to skip auth in dev. |
| `ADMIN_API_KEY` | No | API key required by admin endpoints (overrides, review). Omit to skip auth in dev. |
| `CRON_SECRET` | No | Vercel Cron authentication secret for `/api/cron/cleanup`. |
| `BLOB_RETENTION_DAYS` | No | How many days to keep captured images before the cron job deletes them (default: `7`). |
| `NEXT_PUBLIC_INFERENCE_BACKEND` | No | `onnx` (default, browser ONNX Runtime) or `http` (local inference server). |
| `NEXT_PUBLIC_INFERENCE_URL` | No | URL of the local inference server when `NEXT_PUBLIC_INFERENCE_BACKEND=http` (default: `http://localhost:8000/detect`). |

---

## How classification works

```
User holds item in front of camera
        ↓
Local CV pipeline detects object
(background subtraction, ROI blob detection — runs entirely on-device)
        ↓
5 quality frames accumulated (motion + sharpness gated)
        ↓
── Tier 1: YOLO26m FP16 (on-demand) ─────────────────────────────────────
YOLO26m runs on-demand when the CV pipeline triggers classification.
Rules cover all 80 COCO classes.
        ↓
If YOLO26m class resolves to not_waste (person, car, furniture, animals…)
        → nothing_detected returned instantly — no YOLO World, no API call
        ↓
If YOLO26m confidence ≥ 0.65 AND class has a waste-stream rule
        → result returned immediately (instant, no server call)
        → YOLO-only log sent to /api/pilot-log (non-blocking)
        ↓
── Tier 2: YOLO World S (on-demand) ──────────────────────────────────────
If YOLO26m confidence < 0.65 (or no waste rule for the class):
  · YOLO World S loads lazily if not yet cached (47.9 MB, ONNX Runtime Web)
  · Runs on ROI crop — ~200–800 ms on CPU
  · 23 consolidated recycling classes: metal cans, cardboard, napkins,
    styrofoam, straws, food containers, milk cartons, etc.
If YOLO World confidence ≥ 0.45
        → result returned immediately (no server call)
        ↓
── Tier 3: OpenAI API (last resort) ──────────────────────────────────────
If both local models yield confidence < 0.30 — API fires in parallel with
YOLO World (no extra wait). Otherwise falls through here when
YOLO World confidence < 0.45.
  · Center short-side square crop (e.g. 720×720 from 1280×720) sent to /api/classify
  · GPT-5.4 nano classifies item + optional preAction guidance (fast path, ~1s)
  · If confidence < 0.5 or item flagged for review
        → escalates to GPT-5.4 mini (accurate path, ~2–4s)
        → mini result used only if it improves on nano
  · Zod validates model JSON output; unknown stream IDs fall back to needs_review
        ↓
── Common path ────────────────────────────────────────────────────────────
Override rules applied (word-boundary pattern matching, sorted by specificity)
        ↓
Trust level determined:
  ≥70% confidence → high    → "Put this in [BIN]"
  40–70%          → medium  → "This looks like it goes in [BIN]" + check bin label
  <40% / review   → low     → best guess + "When in doubt, use [default]"
        ↓
Pre-action shown if applicable (e.g. "Empty contents and remove cap")
        ↓
Result shown to user; frame upload to Blob + Redis logging happen asynchronously (non-blocking)
```

---

## Reliability features

| Feature | Behaviour |
|---------|-----------|
| **Error boundary** | Any render crash shows a recovery screen and auto-reloads after 10 seconds |
| **API timeout** | OpenAI calls are aborted after 15 seconds — the kiosk never hangs indefinitely |
| **Configurable rate limit** | `RATE_LIMIT_MAX` env var controls per-IP limit (default 15/min); client waits 1.2s and retries once on 429 |
| **Differentiated errors** | Timeout errors show "connection slow" message; other failures show "classification failed" — never silently swallowed |
| **Config hot-reload** | Site config is cached for 5 minutes — override updates propagate without restart |
| **Pending-item queue** | One-slot queue remembers an item detected while busy; cooldown exits directly to `object_detected` so the next scan starts without re-presentation |
| **Session tokens** | HMAC-signed tokens issued at page load limit classify API abuse; client auto-refreshes via `/api/session` before expiry |
| **YOLO fallback** | If ONNX Runtime or either YOLO model fails to load, the pipeline falls back to the next tier transparently |
| **Parallel API race** | When YOLO26m confidence < 0.30, the API fires in parallel with YOLO World — whichever finishes first wins, so low-confidence items never block on two sequential inferences |

---

## Security

### Session token system

On page load the server component generates an HMAC-SHA256-signed session token and passes it to the kiosk client. Every classify and pilot-log request includes the token in the `x-session-token` header. The server validates the signature and enforces a per-token request limit. The client refreshes the token via `GET /api/session` every few hours without a full page reload.

### Two-tier auth

| Tier | Env var | Mechanism | Endpoints protected |
|------|---------|-----------|---------------------|
| Kiosk | `KIOSK_API_TOKEN` | Bearer token in route handler | `/api/classify`, `/api/feedback`, `/api/pilot-log` (POST) |
| Admin | `ADMIN_API_KEY` | HTTP Basic Auth → session cookie (middleware) | `/dashboard`, `/review`, `/api/review/*`, `/api/overrides`, `/api/stats-stream`, `/api/pilot-log` (DELETE) |

Both default to open (no auth) when the env var is unset, so local development requires no configuration. Admin auth is handled entirely by middleware — after the initial Basic Auth prompt, a session cookie (7 days) eliminates further password prompts.

### Image privacy

Captured images are uploaded to Vercel Blob with public access (required by `@vercel/blob` v2 for server-side reads). Privacy is enforced at the application layer:
- URLs include a random suffix — non-guessable and non-enumerable
- URLs are only exposed through admin-authenticated routes (`/review`, `/api/pilot-image`)
- Images are auto-deleted after `BLOB_RETENTION_DAYS` (default: 7 days)
- Set `BLOB_ENABLED=false` to disable image uploads entirely

---

## Computer vision pipeline

The local CV pipeline uses **HSV color-space skin detection** instead of RGB heuristics. The HSV approach (`h ≤ 50, 0.1 ≤ s ≤ 0.8, v ≥ 0.2`) is significantly more equitable across skin tones — it avoids the bias inherent in RGB-range thresholds that tend to work better for lighter skin. The skin ratio gate (`MAX_SKIN_RATIO = 0.80`) prevents classifying a hand as an object while still allowing items held in-hand.

Timing is tuned for kiosk responsiveness:
- **Result display**: stays on screen until the item is removed (30-second escape hatch)
- **Cooldown**: 1.5 seconds between scans
- **Object removal detection**: 3 consecutive empty frames

### Pending-item queue

The pipeline holds a single-slot queue so back-to-back scans feel instant. If a foreground blob is detected for 3 consecutive frames while the pipeline is busy (classifying, result, or cooldown), the pending flag is set. When the cooldown ends, the pipeline skips the idle state entirely and jumps straight to `object_detected`, so the next scan begins immediately without the user needing to re-present the item. Queue depth is exactly 1 — a second arrival overwrites the first (last-wins). Manual recalibration flushes the queue.

---

## Customising waste rules

Rules live in JSON files in `config/sites/`. No code changes needed.

### Site config structure

```json
{
  "siteId": "my-office",
  "siteName": "My Office — 2nd Floor",
  "defaultLocale": "en",
  "reviewThreshold": 0.55,
  "mirrorCamera": false,
  "streams": [
    { "id": "recycling", "label": "Recycling", "color": "#2563EB", "description": "..." },
    { "id": "compost",   "label": "Compost",   "color": "#16A34A", "description": "..." },
    { "id": "landfill",  "label": "Landfill",  "color": "#525252", "description": "..." }
  ],
  "overrides": [
    { "pattern": "coffee cup", "stream": "landfill", "note": "Lined cups are not recyclable." }
  ],
  "siteRules": [
    { "pattern": "toner", "instruction": "Leave by the copy room.", "stream": "special", "requiresStaff": true }
  ],
  "staffHandlingItems": ["fluorescent", "chemical"],
  "defaultStream": "landfill"
}
```

To create rules for a new location, copy `config/sites/default.json` to `config/sites/your-site.json`, edit it, and set `SITE_ID=your-site` in your Vercel environment variables. Set `defaultLocale` to `"ja"` for Japanese-first sites.

### Japanese waste streams

The `japan-office` config demonstrates fully localized streams: `burnable`, `non-burnable`, `recyclable`, `plastic`, `special`, and `needs_review`. Overrides support Japanese item names (e.g. `ペットボトル` → recyclable, `電池` → special). See `config/sites/japan-office.json` for a full example.

### Override pattern matching

Patterns use **word-boundary matching** — a pattern of `"cup"` matches `"paper cup"` but not `"cupcake"`. Patterns are matched by specificity — `"coffee cup"` takes priority over `"cup"` automatically.

### Confidence threshold

`reviewThreshold` (default `0.55`) controls when a result is treated as uncertain and shown with a hedge. Lower it to be more permissive; raise it to require higher confidence before showing a definitive bin.

---

## Post-pilot workflow

After a real-world test:

1. Go to `/dashboard` to see accuracy rate and most-corrected items
2. Go to `/review` — **all classifications** appear with their captured images in a filterable grid, with model name and sharpness score per entry
3. Mark each entry as **Correct**, **Wrong** (model's class name doesn't match what's in the image), or **Nothing** (false detection)
4. Download a **ZIP archive** of flagged images (Wrong + low-confidence Correct) for use in annotation tools
5. Use insights to add override rules in `config/sites/*.json`

> **Note:** Dashboard stats reflect only items with explicit human feedback — either kiosk user taps (Correct/Wrong) or admin review verdicts. Unreviewed items are excluded so stats reflect confirmed data only.

All raw data is in your Upstash console:
- `recycling:pilot-log` — every classification (item, stream, confidence, model used, latency, image URL)
- `recycling:feedback` — every kiosk user response (correct / wrong + actual stream if provided)
- `recycling:review-verdicts` — admin review verdicts (correct / wrong / false_detection) keyed by requestId
- `recycling:dynamic-overrides:{siteId}` — overrides added via the dashboard

### Data retention

A Vercel Cron job runs daily at 03:00 UTC (`/api/cron/cleanup`). It:
1. Archives the current pilot log and feedback data as JSONL files to `archives/YYYY-MM-DD/` in Blob
2. Deletes captured images older than `BLOB_RETENTION_DAYS` days (default: 7)

You can also trigger manual purges from the dashboard using the date-range data management UI, which calls `DELETE /api/pilot-log`.

---

## Project structure

```
├── app/
│   ├── api/
│   │   ├── classify/       # Classification endpoint (YOLO + OpenAI + waste rules + rate limiting)
│   │   ├── cron/
│   │   │   └── cleanup/    # Daily cron: archive data to Blob, delete old images
│   │   ├── feedback/       # User feedback endpoint
│   │   ├── feedback-stats/ # Aggregated stats for dashboard
│   │   ├── health/         # Service health check
│   │   ├── kiosk-stats/    # Today's classification success rate
│   │   ├── overrides/      # Dynamic override management
│   │   ├── pilot-image/    # Signed URL proxy for private blob images
│   │   ├── pilot-log/      # Pilot log read/write/purge (GET/POST/DELETE)
│   │   ├── review/         # Review verdicts, entry deletion, data export
│   │   ├── session/        # Session token issuance (rate limited)
│   │   ├── site-config/    # Returns site defaultLocale + streams for client use
│   │   └── stats-stream/   # Server-sent events for live dashboard
│   ├── dashboard/          # Live stats (accuracy rate, most-corrected items)
│   ├── review/             # Human review — Correct/Wrong/Nothing verdicts, ZIP export for annotation
│   └── page.tsx            # Kiosk entry point (server component, passes site config to client)
├── components/
│   ├── AdminNav.tsx        # Shared admin navigation (dashboard ↔ review)
│   ├── CameraFeed.tsx      # Camera initialisation + frame capture (mirror prop)
│   ├── CameraScreen.tsx    # Camera view state (scanning / detecting)
│   ├── ErrorBoundary.tsx   # Crash recovery with auto-reload
│   ├── IdleScreen.tsx      # Idle / attract screen
│   ├── KioskDisplay.tsx    # 6-state CV pipeline + state machine orchestrator
│   └── ResultScreen.tsx    # Trust-level result display + feedback UI
├── config/
│   └── sites/              # Per-location waste rule JSON files
│       ├── default.json
│       ├── office-hq.json
│       ├── airport.json
│       ├── pilot.json
│       └── japan-office.json  # Japanese streams (burnable/non-burnable/recyclable/plastic)
├── public/
│   └── models/
│       └── yolo-world-rules.json  # 30-class YOLO World → waste stream mapping
├── kiosk/                  # Kiosk deployment scripts
│   ├── setup-mac.sh              # macOS M1/M2 setup (screensaver, updates, LaunchAgent)
│   ├── start-kiosk-mac.sh        # Auto-restart Chrome kiosk mode
│   ├── setup-pi.sh               # Raspberry Pi setup
│   ├── start-kiosk.sh            # Generic Linux kiosk startup
│   ├── backup-data.sh            # Data backup script
│   └── kiosk.desktop             # Linux desktop entry
├── training/               # Model training and export scripts
│   ├── export_yolo_world.py       # Export yolov8s-worldv2 to ONNX with pre-baked embeddings
│   ├── finetune_yolo26n.ipynb     # Fine-tune YOLO26n on recycling dataset
│   ├── prepare_dataset.py         # Dataset prep (OIDv6 + TACO)
│   ├── prepare_pilot_data.py      # Convert pilot log images to training data
│   └── supplement_and_train.py    # Supplement and retrain pipeline
├── __tests__/              # Jest unit tests
└── lib/
    ├── auth.ts              # Two-tier API auth (kiosk token + admin key)
    ├── empty-module.js      # Stub for ONNX Runtime server-side imports
    ├── auto-override.ts     # Automatic override suggestion from feedback data
    ├── background-task.ts   # waitUntil wrapper for post-response work
    ├── blob-store.ts        # Vercel Blob upload helper (private by default)
    ├── feedback-analysis.ts # Feedback aggregation + override suggestions
    ├── frame-analyzer.ts    # Local CV pipeline (background model, blob detection)
    ├── i18n.ts              # EN/JA translations
    ├── inference-backend.ts # YOLO inference backend abstraction (ONNX or HTTP)
    ├── kiosk-auth-client.ts # Client-side session token management
    ├── kiosk-stats.ts       # Today's success rate computation
    ├── offline-cache.ts     # Browser localStorage result cache (50 items, 24h TTL)
    ├── pilot-log.ts         # Redis logging
    ├── redis.ts             # Upstash Redis client
    ├── request-id.ts        # Per-request UUID for log correlation
    ├── session-token.ts     # HMAC-signed session token generation + validation
    ├── site-streams-context.tsx # React context providing site streams to client components
    ├── types.ts             # Shared TypeScript types
    ├── waste-rules-core.ts  # Core rules engine (pattern matching, stream resolution)
    ├── waste-rules.ts       # Rules engine public API (overrides, result building)
    ├── yolo-inference.ts    # YOLO26m FP16 ONNX Runtime Web inference (on-demand)
    ├── yolo-world-inference.ts # YOLO World S ONNX Runtime Web inference (on-demand fallback)
    └── yolo-rules.ts        # COCO-80 class → waste stream mapping rules
```

---

## Running tests

```bash
npm test
```

87 unit tests covering the state machine, CV pipeline thresholds, HSV skin detection, override pattern matching, Japanese site config, offline cache, and classification API route.

---

## License

MIT
