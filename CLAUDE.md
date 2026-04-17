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

## Tech Stack
- TypeScript / Next.js 16 (App Router) / React 19 / Tailwind CSS v4
- YOLO26m FP16 (ONNX Runtime Web) — browser object detection, 15 custom waste classes (`15class_v1.onnx`, 39 MB)
- OpenAI `gpt-5.4-mini` — cloud fallback (single-model path) when local YOLO confidence is below the fallback threshold
- Upstash Redis (REST) / Vercel Blob / Vercel Serverless + Cron
- Zod v4 / Jest v30 (267 tests, 14 suites) / EN+JA i18n (125+ keys)

## Commands
    npm run dev      # Dev server (Turbopack)
    npm run build    # Production build
    npm test         # 267 Jest tests, 14 suites
    npm run lint     # ESLint

## Architecture
- `app/api/classify/route.ts` — Classification endpoint (GPT-5.4 mini, overrides, Blob upload); supports single + batch (up to 4 items) formats
- `lib/threshold-config.ts` — Master sensitivity (0–1) → all detection/inference thresholds; auto-calibration aware
- `lib/frame-analyzer.ts` — CV pipeline: 120x120 canvas, ~33fps, background subtraction, auto-calibration, multi-blob detection (top 4 with per-blob sharpness/contrast/skin/saturation scoring)
- `lib/yolo-inference.ts` — YOLO26m wrapper (Tier 1: 15 custom waste classes; instant result when confidence ≥ YOLO_FALLBACK_THRESHOLD = 0.75 at default sensitivity); WebGPU primary, WASM fallback
- `lib/rgb-material-analyzer.ts` — Post-YOLO RGB/texture analysis: color (HSV), transparency, metallicity, bbox aspect ratio, LBP texture → refines YOLO class names + feeds MaterialHint to GPT
- `lib/inference-backend.ts` — 2-tier orchestration (YOLO → GPT-5.4 mini); sequential model startup with `overallReady` gate
- `lib/waste-rules-core.ts` — Word-boundary pattern matching + override engine (browser-safe)
- `lib/waste-rules.ts` — Site config loader + GPT prompt builder (5-min cache)
- `components/KioskDisplay.tsx` — State machine: loading → idle → object_detected → classifying → result → cooldown; multi-item blob-to-detection matching (up to 4), three-way routing (YOLO match above threshold → instant result, YOLO match below threshold → GPT-5.4 mini, unmatched+object → GPT-5.4 mini, unmatched+noise → discard)
- `config/sites/*.json` — Per-site waste rules (4 presets: japan-office, office-hq, airport, pilot; japan-office is the default)
- `middleware.ts` — Admin auth: HTTP Basic Auth → 4-hour session cookie

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

## Multi-Agent Pipeline

### Trigger Detection
When the user expresses intent to **implement, add, build, fix, review, or develop** something, look for phrases like:
- "add a feature for...", "build ...", "implement ...", "fix the ...", "I want to ...", "let's create ...", "develop ...", "can you make ..."

Do NOT trigger on questions, explanations, or research requests (e.g., "how does X work?", "explain Y").

When intent is detected, **always ask first**:
- "Would you like me to start the multi-agent pipeline (Planner → Generator → Evaluator), or would you prefer to handle this directly?"

Only launch the pipeline if the user confirms. If the user declines, proceed as a normal Claude Code session.

### Pipeline Flow

The pipeline uses the Agent tool to invoke sub-agents defined in `.claude/agents/`. Inter-agent state is stored in `.claude/workspace/`.

```
1. Detect intent → launch Planner agent
2. Planner dialogues with user → generates .claude/workspace/PLAN.md → waits for user confirmation
3. User confirms → initialize STEP_CURRENT.md to Step 1 → begin step loop
4. Generator reads all of PLAN.md → implements Step N
5. Evaluator reviews Step N → OK or NO
   - NO → writes specific feedback to STEP_N_REVIEW.md → Generator revises → back to step 5
   - OK → logs approval to STEP_N_REVIEW.md → advances STEP_CURRENT.md → back to step 4
6. All steps OK → Evaluator creates commit + opens PR + displays summary in chat
```

### Agent Definitions
- `.claude/agents/planner.md` — Clarifies user intent, produces PLAN.md (what, not how)
- `.claude/agents/generator.md` — Implements each step, makes all technical decisions
- `.claude/agents/evaluator.md` — Reviews implementation against plan, approves or returns feedback

### Workspace Files (`.claude/workspace/`)
- `PLAN.md` — Structured plan generated by Planner
- `STEP_CURRENT.md` — Current step number and status
- `STEP_N_REVIEW.md` — Evaluator decision log per step (e.g., STEP_1_REVIEW.md)
- `FINAL_SUMMARY.md` — Summary of all changes after pipeline completes

### Invoking Agents
Each agent is invoked as a sub-agent via the Agent tool:
```
Agent(prompt: "Follow the instructions in .claude/agents/planner.md. [context]")
Agent(prompt: "Follow the instructions in .claude/agents/generator.md. [context]")
Agent(prompt: "Follow the instructions in .claude/agents/evaluator.md. [context]")
```

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
