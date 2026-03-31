# Recycling Buddy Kiosk

A real-time AI-powered waste sorting kiosk. Hold any item in front of the camera and it tells you which bin it belongs in — no app, no phone, no buttons required.

Built for office and public-space pilots, with full English and Japanese support. Configurable per-site waste streams, pre-disposal guidance, and bias-aware computer vision.

---

## What it does

- Detects objects held up to the camera using local computer vision — no cloud needed for detection
- Captures a frame and classifies the item using OpenAI vision models
- Shows a **clear directive** based on confidence level — no raw percentages shown to users:
  - High confidence → **"Put this in Recycling"**
  - Medium confidence → **"This looks like it goes in Landfill"** + a soft note to check the bin label
  - Low confidence → best guess with **"When in doubt, use Landfill"** fallback
- Shows **pre-disposal guidance** when needed (e.g. "Empty contents and remove cap") before the bin directive
- Supports **English and Japanese** with configurable default locale per site
- Lets users tap **Correct / Wrong** to give feedback — the "Wrong" correction menu dynamically shows the site's configured streams
- Logs every scan and all feedback to Redis for post-pilot analysis
- Saves captured images as **private blobs** served through signed-URL proxy — no public URLs

---

## How to use it

1. Open the kiosk URL on any device with a camera
2. Hold one item in front of the camera
3. Wait for the result — typically 1–3 seconds
4. Dispose of the item in the indicated bin
5. Optionally tap **Correct** or **Wrong** to give feedback

---

## Pages

| URL | Purpose |
|-----|---------|
| `/` | The kiosk itself |
| `/dashboard` | Live accuracy stats, most-corrected items, suggested override rules |
| `/review` | Post-pilot image review — assign correct bins to misclassified items |

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, TypeScript) |
| Styling | Tailwind CSS v4 |
| AI classification | OpenAI GPT vision — nano (fast) with mini escalation (accurate) |
| Local detection | OffscreenCanvas background subtraction at 160×120, ~7 fps, HSV-based skin filtering |
| Response validation | Zod schema validation on all model output |
| Database | Upstash Redis (pilot logs + feedback) |
| Image storage | Vercel Blob (captured frames) |
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
| `BLOB_ACCESS` | No | `private` (default) or `public`. Private blobs are served via `/api/pilot-image` with signed URLs. |
| `NEXT_PUBLIC_MIRROR_CAMERA` | No | Set to `true` for front-facing / selfie cameras. Omit or set `false` for outward-facing kiosk cameras. |
| `RATE_LIMIT_MAX` | No | Max classifications per IP per minute (default: `15`) |

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
ROI crop captured (70% of frame), scaled to max 320px, sent to /api/classify
        ↓
GPT nano classifies item + optional preAction guidance (fast path, ~1s)
        ↓
If confidence < 0.5 or item flagged for review
        → escalates to GPT mini (accurate path, ~2–4s)
        → mini result used only if it improves on nano
        ↓
Zod validates model JSON output; unknown stream IDs fall back to needs_review
        ↓
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

---

## Computer vision pipeline

The local CV pipeline uses **HSV color-space skin detection** instead of RGB heuristics. The HSV approach (`h ≤ 50, 0.1 ≤ s ≤ 0.8, v ≥ 0.2`) is significantly more equitable across skin tones — it avoids the bias inherent in RGB-range thresholds that tend to work better for lighter skin. The skin ratio gate (`MAX_SKIN_RATIO = 0.80`) prevents classifying a hand as an object while still allowing items held in-hand.

Timing is tuned for kiosk responsiveness:
- **Result display**: 4 seconds (then auto-transitions to cooldown)
- **Cooldown**: 1.5 seconds between scans
- **Object removal detection**: 2 consecutive empty frames

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

1. Go to `/dashboard` to see accuracy rate, most-corrected items, and auto-suggested override rules
2. Go to `/review` — every item a user marked as **Wrong** appears with its captured image
3. For each card, click the correct bin to record the true classification
4. Use the corrected data to add override rules in the relevant `config/sites/*.json` file

> **Note:** When users tap "Wrong" on the kiosk, their feedback is logged for post-pilot review. Use the `/review` page to assign correct bins to misclassified items.

All raw data is in your Upstash console:
- `recycling:pilot-log` — every classification (item, stream, confidence, model used, latency, image URL)
- `recycling:feedback` — every user response (correct / wrong + actual stream if provided)
- `recycling:corrections` — human-assigned correct bins from the review page
- `recycling:dynamic-overrides:{siteId}` — overrides added via the dashboard

---

## Project structure

```
├── app/
│   ├── api/
│   │   ├── classify/       # Classification endpoint (OpenAI + waste rules + rate limiting)
│   │   ├── feedback/       # User feedback endpoint
│   │   ├── feedback-stats/ # Aggregated stats for dashboard
│   │   ├── health/         # Service health check
│   │   ├── overrides/      # Dynamic override management
│   │   ├── pilot-image/    # Signed URL proxy for private blob images
│   │   ├── review/         # Review page data + correction saving
│   │   ├── site-config/    # Returns site defaultLocale + streams for client use
│   │   └── stats-stream/   # Server-sent events for live dashboard
│   ├── dashboard/          # Live stats page
│   ├── review/             # Post-pilot image review page
│   └── page.tsx            # Kiosk entry point (server component, passes site config to client)
├── components/
│   ├── CameraFeed.tsx      # Camera initialisation + frame capture (mirror prop)
│   ├── ErrorBoundary.tsx   # Crash recovery with auto-reload
│   ├── KioskDisplay.tsx    # 6-state CV pipeline + state machine
│   └── LiveOverlay.tsx     # Trust-level result display + feedback UI
├── config/
│   └── sites/              # Per-location waste rule JSON files
│       ├── default.json
│       ├── office-hq.json
│       ├── airport.json
│       └── japan-office.json  # Japanese streams (burnable/non-burnable/recyclable/plastic)
├── __tests__/              # Jest unit tests (67 tests)
└── lib/
    ├── blob-store.ts        # Vercel Blob upload helper (private by default)
    ├── site-streams-context.tsx # React context providing site streams to client components
    ├── feedback-analysis.ts # Feedback aggregation + override suggestions
    ├── frame-analyzer.ts    # Local CV pipeline (background model, blob detection)
    ├── i18n.ts              # EN/JA translations
    ├── offline-cache.ts     # Browser localStorage result cache (50 items, 24h TTL)
    ├── pilot-log.ts         # Redis logging
    ├── redis.ts             # Upstash Redis client
    ├── request-id.ts        # Per-request UUID for log correlation
    ├── types.ts             # Shared TypeScript types
    └── waste-rules.ts       # Rules engine (pattern matching, overrides, result building)
```

---

## Running tests

```bash
npm test
```

67 unit tests covering the state machine, CV pipeline thresholds, HSV skin detection, override pattern matching, Japanese site config, offline cache, and classification API route.

---

## License

MIT
