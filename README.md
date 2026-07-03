<p align="center">
  <strong>English</strong>
  &nbsp;·&nbsp;
  <a href="README.ja.md">日本語</a>
</p>

# wayste

<p align="center">
  <img src="public/marketing/hook-1.png" alt="wayste kiosk in use — a hand holding a plastic cup over labelled bins" width="720">
</p>

<p align="center">
  <a href="https://wayste.vercel.app/"><strong>Live demo →</strong></a>
  &nbsp;·&nbsp;
  <a href="https://wayste.vercel.app/kiosk"><strong>Try the kiosk →</strong></a>
</p>

A real-time AI waste-sorting kiosk. Walk up to the bins holding any item, and a fixed downward camera tells you in seconds which bin it belongs in — no app, no phone, no buttons.

Built for office and public-space pilots. **Classification is fully on-device**: frames stay in the browser for privacy and zero per-scan cost, and items the local model can't confidently identify are flagged for staff review instead of being sent to a cloud AI. (A legacy cloud-escalation path survives behind a flag, for pilot experiments only.) Full English and Japanese support, per-site configurable waste streams, and bias-aware computer vision.

> **Status:** Demo running on Vercel; pilot tests being arranged with universities and corporate offices in Japan. Not yet in production.

## Why I built this

Office and airport bins in Japan often have 4–6 streams (burnable, plastic, PET, cans, paper, special) and the labels are dense. People glance for ~2 seconds, give up, and toss everything in landfill. A traditional app doesn't work — nobody wants to scan a QR code while holding trash. So the design constraint was: **zero user effort, zero install, real-time guidance** — which forced an architecture where a fixed camera sees only the trash and the user's hand, never their face, and the model runs in the browser so frames stay on-device — anything it can't confidently identify is flagged for staff review rather than sent to a cloud AI.

## Engineering highlights

- **Local-only pipeline** — a custom 15-class YOLO26m model runs in the browser via ONNX Runtime Web; high-confidence detections resolve instantly with no server call, and anything it can't confidently identify becomes a needs-review result on-device. No frame is ever sent to a cloud AI (a legacy GPT escalation remains behind `NEXT_PUBLIC_CLOUD_FALLBACK=1`, for pilot experiments such as the cloud-vs-local comparison).
- **Fairness in CV** — skin detection in HSV (`h ≤ 50, 0.1 ≤ s ≤ 0.8, v ≥ 0.2`) instead of RGB ranges, because RGB skin heuristics are biased toward lighter skin and fail in real-world deployments.
- **Sensitivity-derived thresholds** — every detection threshold (foreground ratio, motion gate, confidence cutoffs) is derived from a single 0–1 `sensitivity` knob in site config. No magic numbers scattered through code.
- **HMAC kiosk session auth** — a long-lived signed cookie keyed by `KIOSK_API_TOKEN`; rotating the token revokes every deployed device at once. Bearer-token unlock flow at `/kiosk/unlock`.
- **Auto-calibration** — first 45 frames measure environment-specific noise floor and override the foreground threshold. The same kiosk works under harsh fluorescent and warm office lighting without retuning.
- **Thermal throttling** — CV analysis duration is tracked continuously; when an M1/M2 Mac throttles under sustained use, the frame rate halves automatically and a warning badge appears.

---

## What it does

- Detects objects held up to the camera using local computer vision — no cloud needed for detection
- Runs a **local-only inference pipeline** — YOLO in the browser, with an on-device fallback:
  - **Tier 1 — YOLO26m (on-demand, browser):** custom 15-class waste detection model (`15class_v1.onnx`, 39 MB) covering bottles, cans, cups, bags, batteries, food waste, and other common items. Runs when the CV pipeline triggers classification; high-confidence detections are resolved instantly with no server call.
  - **Fallback — on-device `needs_review`:** when YOLO confidence is below the sensitivity-derived threshold (~0.725 at default sensitivity 0.5), or a foreground blob has no matching detection, the kiosk shows "needs verification" and points the user to the bin labels or staff — without sending the frame anywhere. (The legacy `gpt-5.4-mini` escalation still exists behind `NEXT_PUBLIC_CLOUD_FALLBACK=1`, for pilot experiments only.)
- Shows a **clear directive** based on confidence level — no raw percentages shown to users:
  - High confidence → **"Put this in Recycling"**
  - Medium confidence → **"This looks like it goes in Landfill"** + a soft note to check the bin label
  - Low confidence → best guess with **"When in doubt, use Landfill"** fallback
- Shows **pre-disposal guidance** when needed (e.g. "Empty contents and remove cap") before the bin directive
- Supports **English and Japanese** with configurable default locale per site
- Detects **compound items** (e.g. a coffee cup with a plastic lid) and breaks them down into per-component disposal instructions
- Detects **up to 4 simultaneous items** via multi-blob analysis with per-blob quality scoring (sharpness, contrast, skin ratio); shows a responsive split-screen layout (2-column, 3-column, or 2×2 grid) with staggered fade-in animations
- **Startup loading screen** — the YOLO model is fully loaded and warmed up before the kiosk accepts input; shows a branded loading screen with a progress indicator until the model is ready
- **Thermal throttling detection** on the kiosk device — when CV analysis times out 2× above baseline, the pipeline automatically halves its frame rate to stay responsive
- Logs every scan to Redis for post-pilot analysis
- Saves captured images to **Vercel Blob** with public access + random-suffix URLs (non-guessable, non-enumerable); only exposed through admin-authenticated routes
- Automatically archives pilot data to Blob and purges old images via a daily cron job

---

## How to use it

1. Open `/kiosk` on any device with a camera (a one-time unlock at `/kiosk/unlock` sets a 30-day session cookie)
2. Hold one item (or multiple items) in front of the camera
3. Wait for the result — instant for common items (YOLO26m), or ~1–3 seconds when GPT-5.4 mini is needed
4. Dispose of the item in the indicated bin — a physical bin position indicator shows where the bin sits in the row
5. Walk away or tap **Done** to return to the idle screen early

---

## Pages

| URL | Purpose |
|-----|---------|
| `/` | Public marketing landing page (10-section product introduction with embedded demos) |
| `/kiosk` | The kiosk display itself — requires a valid `kiosk_session` cookie |
| `/kiosk/unlock` | One-time unlock UI for a new kiosk device — sets the 30-day `kiosk_session` cookie |
| `/insights` | Operations dashboard — pipeline funnel, top misclassifications, daily time series (admin-gated) |
| `/review` | Human review — browse all classifications, mark each as Correct/Wrong/Nothing (false detection), download ZIP of flagged images for annotation (admin-gated) |

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16.2.4 (App Router, TypeScript) |
| Styling | Tailwind CSS v4 |
| Local inference (Tier 1) | YOLO26m FP16 — custom 15-class waste model (`15class_v1.onnx`, 39 MB) via ONNX Runtime Web — on-demand |
| Cloud escalation (pilot experiments only) | OpenAI `gpt-5.4-mini`, behind `NEXT_PUBLIC_CLOUD_FALLBACK=1` — the default kiosk never calls it |
| Local detection | OffscreenCanvas background subtraction at 120×120 (square), ~33 fps, multi-blob analysis (up to 4), auto-calibrating thresholds |
| Response validation | Zod schema validation on all model output |
| API security | HMAC-signed session tokens + two-tier auth (kiosk token / admin key) |
| Database | Upstash Redis (pilot logs + admin review verdicts) |
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
git clone https://github.com/ryuto1127/wayste.git
cd wayste
npm install
```

Create `.env.local`:

```env
OPENAI_API_KEY=sk-...
```

```bash
npm run dev
```

- [http://localhost:3000](http://localhost:3000) → public marketing landing page
- [http://localhost:3000/kiosk](http://localhost:3000/kiosk) → the kiosk itself (allow camera access when prompted)

In dev, the kiosk session gate is bypassed when `KIOSK_API_TOKEN` is unset, so you can open `/kiosk` directly.

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
| `SITE_ID` | No | Site config to load (default: `japan-office`). The site config's `defaultLocale` sets the UI language. |
| `BLOB_ENABLED` | No | Set to `false` to disable all image uploads entirely (default: enabled). |
| `NEXT_PUBLIC_MIRROR_CAMERA` | No | Set to `true` for front-facing / selfie cameras. Omit or set `false` for outward-facing kiosk cameras. |
| `RATE_LIMIT_MAX` | No | Max classifications per IP per minute (default: `15`) |
| `OPENAI_DAILY_BUDGET` | No | Hard cap on OpenAI classification calls per UTC day. Recommended: `500` for pilot, `5000` for production. Unset = no cap. |
| `KIOSK_API_TOKEN` | Production | **Server-only** bearer token required by kiosk endpoints (`/api/classify`, `/api/pilot-log` POST). Omit on localhost to skip auth in dev. Never expose via `NEXT_PUBLIC_*`. Unlock a new kiosk device at `/kiosk/unlock`. |
| `BLOB_STORE_HOST` | Production | Your Vercel Blob store's full hostname (e.g. `abc123.public.blob.vercel-storage.com`). Prevents the blob bearer token from being sent to an attacker-controlled store. |
| `ADMIN_API_KEY` | No | Password required by admin pages (`/insights`, `/review`) via HTTP Basic Auth → 4-hour session cookie. Omit to skip auth in dev. Rotate to invalidate every issued session. |
| `CRON_SECRET` | No | Vercel Cron authentication secret for `/api/cron/cleanup`. |
| `BLOB_RETENTION_DAYS` | No | How many days to keep captured images before the cron job deletes them (default: `90`). |
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
── Tier 1: YOLO26m FP16 (on-demand, browser) ────────────────────────────
YOLO26m (custom 15-class waste model) runs on-demand when the CV pipeline
triggers classification. All 15 classes are waste items (bottles, cans, cups,
bags, batteries, food waste, etc.) — every detection maps to a disposal stream.
        ↓
If YOLO26m confidence ≥ YOLO_FALLBACK_THRESHOLD (~0.725 at default sensitivity 0.5)
        → result returned immediately (instant, no server call)
        → YOLO-only log sent to /api/pilot-log (non-blocking)
        ↓
── Fallback: on-device needs_review ──────────────────────────────────────
Fires when YOLO confidence is below the fallback threshold, or when a
foreground blob exists with no matching YOLO detection.
  · Resolved entirely on-device: the item is shown as "needs verification"
    with guidance to check the bin labels or ask staff — no cloud call
  · Logged (metadata; frame attached only when the face check passes) to
    /api/pilot-log for the admin review loop
  · Legacy mode (NEXT_PUBLIC_CLOUD_FALLBACK=1, pilot experiments only):
    the crop is sent to /api/classify and gpt-5.4-mini classifies instead
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
Result shown to user in fullscreen hero (single item) or split-screen grid (2–4 items);
each blob is matched to YOLO detections by center proximity — unmatched blobs with
high quality scores (sharpness + contrast) are sent to GPT; low-quality blobs are discarded.
Frame upload to Blob + Redis logging happen asynchronously (non-blocking)
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
| **Kiosk session cookie** | Long-lived HMAC-signed `kiosk_session` cookie (30 days) authorises classify + pilot-log POSTs; rotating `KIOSK_API_TOKEN` revokes every cookie |
| **Model startup gate** | YOLO model loads + warms up at startup; loading screen blocks kiosk input until `overallReady` is true |
| **Thermal throttling** | CV analysis duration is tracked continuously; when average exceeds 2× baseline (M1/M2 Mac thermal throttle), the frame rate halves automatically and a warning badge appears |

---

## Security

### Session token system

A new kiosk device exchanges the bearer `KIOSK_API_TOKEN` for an HMAC-SHA256-signed `kiosk_session` cookie via `POST /api/kiosk/session` (or via the `/kiosk/unlock` UI). The cookie lasts 30 days; rotating `KIOSK_API_TOKEN` invalidates every issued cookie. Every classify and pilot-log POST verifies either the cookie or the bearer token before doing any work.

### Two-tier auth

| Tier | Env var | Mechanism | Endpoints protected |
|------|---------|-----------|---------------------|
| Kiosk | `KIOSK_API_TOKEN` | `kiosk_session` cookie OR `Authorization: Bearer <token>` | `/api/classify`, `/api/pilot-log` (POST) |
| Admin | `ADMIN_API_KEY` | HTTP Basic Auth → 4-hour session cookie (middleware) | `/insights`, `/review`, `/api/review/*`, `/api/dashboard-metrics`, `/api/pilot-log` (DELETE) |

Both default to open (no auth) when the env var is unset, so local development requires no configuration. Admin auth is handled entirely by middleware — after the initial Basic Auth prompt, a session cookie (4 hours) eliminates further password prompts.

### Image privacy

Captured images are uploaded to Vercel Blob with public access (required by `@vercel/blob` v2 for server-side reads). Privacy is enforced at the application layer:
- URLs include a random suffix — non-guessable and non-enumerable
- URLs are only exposed through admin-authenticated routes (`/review`, `/api/pilot-image`)
- Images are auto-deleted after `BLOB_RETENTION_DAYS` (default: 90 days)
- Set `BLOB_ENABLED=false` to disable image uploads entirely

---

## Computer vision pipeline

The local CV pipeline uses **HSV color-space skin detection** instead of RGB heuristics. The HSV approach (`h ≤ 50, 0.1 ≤ s ≤ 0.8, v ≥ 0.2`) is significantly more equitable across skin tones — it avoids the bias inherent in RGB-range thresholds that tend to work better for lighter skin. The skin ratio gate (`MAX_SKIN_RATIO = 0.80`) prevents classifying a hand as an object while still allowing items held in-hand.

**Auto-calibration**: during the first 45 frames (background settling), the pipeline measures noise-floor statistics (mean foreground ratio, standard deviation, largest blob baseline). These are used to derive an environment-specific `ROI_FG_THRESHOLD` that adapts to each camera's noise characteristics.

**Sensitivity**: a single `sensitivity` parameter (0.0 = strict, 1.0 = sensitive, default 0.5) in the site config controls all detection and inference thresholds via `computeThresholds()` in `lib/threshold-config.ts`. Auto-calibration overrides the foreground threshold when available.

Timing is tuned for kiosk responsiveness:
- **Result display**: stays on screen until the item is removed (30-second escape hatch)
- **Cooldown**: 1.5 seconds between scans
- **Object removal detection**: 3 consecutive empty frames (2 at sensitivity > 0.7)

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
  "sensitivity": 0.5,
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

To create rules for a new location, copy `config/sites/japan-office.json` (the default) or `config/sites/office-hq.json` to `config/sites/your-site.json`, edit it, and set `SITE_ID=your-site` in your Vercel environment variables. Set `defaultLocale` to `"ja"` for Japanese-first sites or `"en"` for English-first sites.

### Japanese waste streams

The `japan-office` config demonstrates fully localized streams: `burnable`, `non-burnable`, `recyclable`, `plastic`, `special`, and `needs_review`. Overrides support Japanese item names (e.g. `ペットボトル` → recyclable, `電池` → special). See `config/sites/japan-office.json` for a full example.

### Override pattern matching

Patterns use **word-boundary matching** — a pattern of `"cup"` matches `"paper cup"` but not `"cupcake"`. Patterns are matched by specificity — `"coffee cup"` takes priority over `"cup"` automatically.

### Confidence threshold

`reviewThreshold` (default `0.55`) controls when a result is treated as uncertain and shown with a hedge. Lower it to be more permissive; raise it to require higher confidence before showing a definitive bin.

---

## Post-pilot workflow

After a real-world test:

1. Go to `/insights` to see the pipeline funnel, top misclassifications, and daily time series
2. Go to `/review` — **all classifications** appear with their captured images in a filterable grid, with model name and sharpness score per entry
3. Mark each entry as **Correct**, **Wrong** (model's class name doesn't match what's in the image), or **Nothing** (false detection)
4. Download a **ZIP archive** of flagged images (Wrong + low-confidence Correct) for use in annotation tools
5. Use insights to add override rules in `config/sites/*.json`

> **Note:** Insights stats reflect only items that have been admin-reviewed at `/review` — there is no in-kiosk feedback button. Unreviewed items are excluded so stats reflect confirmed data only.

All raw data is in your Upstash console:
- `recycling:pilot-log` — every classification (item, stream, confidence, model used, latency, image URL)
- `recycling:review-verdicts` — admin review verdicts (correct / wrong / false_detection) keyed by requestId

### Data retention

A Vercel Cron job runs daily at 03:00 UTC (`/api/cron/cleanup`). It:
1. Archives the current pilot log as a JSONL file to `archives/YYYY-MM-DD/` in Blob
2. Deletes captured images older than `BLOB_RETENTION_DAYS` days (default: 90)

A second weekly cron (`/api/cron/export-finetuning`) exports the pilot log as a structured fine-tuning dataset to Blob, ready for model retraining.

You can also trigger manual purges from the insights dashboard using the date-range data management UI, which calls `DELETE /api/pilot-log`.

---

## Project structure

```
├── app/
│   ├── api/
│   │   ├── calibration/         # Calibration prediction tracking (Redis-backed)
│   │   ├── classify/            # Single + batch classification (GPT-5.4 mini, overrides, Blob upload)
│   │   ├── cron/
│   │   │   ├── cleanup/             # Daily cron: archive pilot log to Blob, delete old images
│   │   │   └── export-finetuning/   # Weekly cron: export pilot log as fine-tuning dataset to Blob
│   │   ├── dashboard-metrics/   # GET aggregation for /insights (funnel + top-misclass + timeseries)
│   │   ├── health/              # Service health check
│   │   ├── kiosk/
│   │   │   └── session/         # POST: exchange KIOSK_API_TOKEN for kiosk_session cookie
│   │   ├── kiosk-stats/         # Today's classification success rate (admin-reviewed only)
│   │   ├── pilot-image/         # Signed URL proxy for blob-hosted captured frames
│   │   ├── pilot-log/           # Pilot log read/write/purge (GET/POST/DELETE)
│   │   ├── review/              # Review verdicts, entry deletion, ZIP/CSV export
│   │   └── site-config/         # Returns site defaultLocale + streams for client use
│   ├── demo/screens/            # Internal screen-state showcase (not user-facing)
│   ├── insights/                # Operations dashboard (funnel, misclassifications, time series)
│   ├── kiosk/                   # Kiosk display (page.tsx) + unlock flow (unlock/page.tsx) + dark fixed-viewport layout
│   ├── review/                  # Human review — Correct/Wrong/Nothing verdicts, ZIP export
│   └── page.tsx                 # Public marketing landing page (10-section product intro)
├── components/
│   ├── AdminNav.tsx             # Shared admin nav (insights ↔ review ↔ kiosk)
│   ├── CameraFeed.tsx           # Camera initialisation + frame capture (mirror prop)
│   ├── CameraScreen.tsx         # Camera view state (scanning / detecting)
│   ├── ErrorBoundary.tsx        # Crash recovery with auto-reload
│   ├── IdleScreen.tsx           # Idle / attract screen
│   ├── KioskDisplay.tsx         # CV pipeline + state machine orchestrator
│   ├── PerformancePanel.tsx     # Per-tab perf charts (CV, YOLO, thermal) — review-page tooling
│   ├── ResultScreen.tsx         # Fullscreen / split-screen bin result (1–4 items, 2×2 grid)
│   ├── SystemStatusBadge.tsx    # YOLO model + thermal warning status indicator
│   └── insights/                # /insights view + chart subcomponents
│       ├── InsightsView.tsx
│       ├── MetricsTimeseries.tsx
│       ├── MisclassTopChart.tsx
│       └── PipelineFunnel.tsx
├── config/
│   └── sites/                   # Per-location waste rule JSON files
│       ├── airport.json
│       ├── japan-office.json    # Default site — Japanese streams (burnable / non-burnable / recyclable / plastic / special)
│       ├── office-hq.json
│       └── pilot.json
├── public/
│   └── models/                  # Browser-served ONNX assets
│       ├── 15class_v1.onnx          # YOLO26m FP16 — runtime detection model
│       └── yolo-rules.json          # YOLO class → waste-stream mapping
├── kiosk/                       # Kiosk deployment scripts
│   ├── setup-mac.sh                 # macOS M1/M2 setup (screensaver, updates, LaunchAgent)
│   ├── start-kiosk-mac.sh           # Auto-restart Chrome kiosk mode
│   ├── setup-pi.sh                  # Raspberry Pi setup
│   ├── start-kiosk.sh               # Generic Linux kiosk startup
│   ├── backup-data.sh               # Data backup script
│   └── kiosk.desktop                # Linux desktop entry
├── training/                    # Offline dataset prep + model training (Python; not runtime)
│   ├── finetune_yolo26n.ipynb       # Fine-tune YOLO26n on the recycling dataset
│   ├── train_clean.py               # Clean-data training entry point
│   ├── prepare_dataset.py           # Dataset prep (OIDv6 + TACO)
│   ├── prepare_pilot_data.py        # Convert pilot-log images into training data
│   ├── build_*_dataset.py           # Class-set-specific dataset builders (39/42/46-class)
│   ├── ai_curate.py / ai_verify_class.py / filter_quality.py  # Quality + class verification
│   └── ...                          # Other notebooks, exporters, and helper scripts
├── __tests__/                   # Jest unit tests (see "Running tests" below)
├── middleware.ts                # Admin Basic Auth → 4-hour session cookie
├── instrumentation.ts           # Next.js instrumentation hook (env validation on boot)
└── lib/
    ├── audit-log.ts                 # Append-only admin action log
    ├── auth.ts                      # (Legacy / unused) — replaced by kiosk-auth.ts + middleware
    ├── background-task.ts           # waitUntil wrapper for post-response work
    ├── bbox-utils.ts                # IoU, frame fingerprint, greedy bbox matching
    ├── blob-store.ts                # Vercel Blob upload helper
    ├── blob-url.ts                  # Allow-list check for blob URL hostnames
    ├── calibration.ts               # Calibration prediction tracking (Redis)
    ├── crypto-utils.ts              # HMAC + constant-time string compare
    ├── daily-budget.ts              # Per-UTC-day OpenAI call cap
    ├── dashboard-metrics.ts         # Pure funcs that build the /insights response
    ├── empty-module.js              # Stub for ONNX Runtime server-side imports
    ├── env-validation.ts            # Boot-time env-var validation
    ├── face-detect.ts               # Browser face-detect (privacy filter)
    ├── face-detect-server.ts        # Server-side face-detect (privacy filter)
    ├── frame-analyzer.ts            # Local CV pipeline (background model, multi-blob detection)
    ├── i18n.ts                      # EN/JA translations
    ├── inference-backend.ts         # YOLO inference backend abstraction (ONNX or HTTP)
    ├── insights-helpers.ts          # Client helpers for the /insights view
    ├── kiosk-auth.ts                # HMAC-signed `kiosk_session` cookie + bearer-token verify
    ├── kiosk-counter.ts             # Per-stream sort counter (live idle-screen stats)
    ├── kiosk-stats.ts               # Today's success rate (admin-reviewed only)
    ├── material-vocabulary.ts       # Material visual cues for the GPT sub-classification prompt
    ├── milestone-check.ts           # Milestone notifications (Resend) on review thresholds
    ├── models/                      # Bundled ONNX assets used server-side (face detector)
    ├── notifications.ts             # Resend email helper
    ├── offline-cache.ts             # Browser localStorage result cache (50 items, 24h TTL)
    ├── openai-pricing.ts            # Token-usage → USD conversion for budget tracking
    ├── perf-monitor.ts              # In-tab perf monitor + BroadcastChannel sync
    ├── pilot-log.ts                 # Redis logging (recycling:pilot-log list)
    ├── pilot-log-schema.ts          # Zod schema for pilot-log entries
    ├── redis.ts                     # Upstash Redis client + key constants
    ├── request-id.ts                # Per-request UUID for log correlation
    ├── rgb-material-analyzer.ts     # Post-YOLO RGB/texture material analysis (color, LBP, shape)
    ├── site-streams-context.tsx     # React context providing site streams to client components
    ├── threshold-config.ts          # Master sensitivity → threshold derivation
    ├── types.ts                     # Shared TypeScript types
    ├── waste-rules-core.ts          # Core rules engine (pattern matching, stream resolution)
    ├── waste-rules.ts               # Rules engine public API (overrides, result building, GPT prompts)
    ├── yolo-inference.ts            # YOLO26m FP16 ONNX Runtime Web inference (on-demand)
    └── yolo-rules.ts                # YOLO class-name → waste-stream mapping (loads /models/yolo-rules.json)
```

---

## Running tests

```bash
npm test
```

465 unit tests across 19 suites covering the state machine, CV pipeline thresholds, threshold sensitivity derivation, override pattern matching, offline cache, notifications, classification API route, multi-item blob detection, sequential model loading, bbox utilities, dashboard metrics + integration, insights helpers, OpenAI pricing/budget, the cloud-vs-local shadow comparison, and analysis exports.

---

## License

MIT
