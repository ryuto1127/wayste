# Recycling Buddy Kiosk

A real-time AI-powered waste sorting kiosk. Hold any item in front of the camera and it tells you which bin it belongs in — instantly.

Built for office and public-space pilots, with a focus on Japan.

---

## What it does

- Detects when an object is held up to the camera using local computer vision (no cloud needed for detection)
- Captures a frame and classifies the item using OpenAI vision models
- Displays the correct bin (recycling, compost, landfill, special waste, etc.) with colour coding
- Supports **English and Japanese**
- Lets users give thumbs up / thumbs down feedback on each result
- Logs every scan and all feedback to a database for post-pilot analysis
- Saves a captured image alongside every log entry so misclassifications can be reviewed visually

---

## How to use it

1. Open the kiosk URL on any device with a camera
2. Hold an item in front of the camera
3. Wait for the result — usually 3–5 seconds
4. Dispose of the item in the indicated bin
5. Optionally tap ✓ or ✗ to confirm or correct the result

---

## Pages

| URL | Purpose |
|-----|---------|
| `/` | The kiosk itself |
| `/dashboard` | Live accuracy stats and feedback summary |
| `/review` | Post-pilot image review — assign correct bins to misclassified items |

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, TypeScript) |
| Styling | Tailwind CSS v4 |
| AI classification | OpenAI GPT vision (nano → mini escalation) |
| Local detection | OffscreenCanvas background subtraction at 160×120 |
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
| `SITE_ID` | No | Site identifier for multi-location use (default: `default`) |

---

## How classification works

```
User holds item in front of camera
        ↓
Local CV pipeline detects object (background subtraction, ROI blob detection)
        ↓
Frame captured and sent to /api/classify
        ↓
GPT nano → classifies item
        ↓
If uncertain or hazardous → escalates to GPT mini
        ↓
Site-specific waste rules applied (overrides, stream mapping)
        ↓
Result shown to user + frame saved to Blob + entry logged to Redis
```

---

## Customising waste rules

Edit `lib/waste-rules.ts` to:
- Add hard overrides for items the model consistently gets wrong
- Adjust confidence thresholds
- Add site-specific bin types or instructions

To create rules for a new location, copy `config/sites/default.json` to `config/sites/your-site.json`, edit it, and set `SITE_ID=your-site` in your environment.

---

## Post-pilot workflow

After a real-world test:

1. Go to `/review` on your deployed URL
2. Every item a user marked as **wrong** appears with its captured image
3. Click the correct bin for each one
4. Use the corrected data to add override rules in `lib/waste-rules.ts`

All raw data is in your Upstash console:
- `recycling:pilot-log` — every classification (item, stream, confidence, model, latency, image URL)
- `recycling:feedback` — every user correction
- `recycling:corrections` — human-assigned correct bins from the review page

---

## Project structure

```
├── app/
│   ├── api/
│   │   ├── classify/       # Classification endpoint (OpenAI + waste rules)
│   │   ├── feedback/       # User feedback endpoint
│   │   ├── feedback-stats/ # Aggregated stats for dashboard
│   │   ├── pilot-image/    # Signed URL proxy for private blob images
│   │   └── review/         # Review page data + correction saving
│   ├── dashboard/          # Live stats page
│   ├── review/             # Post-pilot image review page
│   └── page.tsx            # Kiosk entry point
├── components/
│   ├── CameraFeed.tsx      # Camera capture
│   ├── KioskDisplay.tsx    # State machine + CV orchestration
│   └── LiveOverlay.tsx     # Result display + feedback UI
├── config/
│   └── sites/              # Per-location waste rule JSON files
└── lib/
    ├── blob-store.ts        # Vercel Blob upload helper
    ├── feedback-analysis.ts # Feedback aggregation
    ├── frame-analyzer.ts    # Local CV pipeline
    ├── i18n.ts              # EN/JA translations
    ├── offline-cache.ts     # Browser localStorage cache
    ├── pilot-log.ts         # Redis logging
    ├── redis.ts             # Upstash Redis client
    ├── types.ts             # Shared TypeScript types
    └── waste-rules.ts       # Classification rules engine
```

---

## License

MIT
