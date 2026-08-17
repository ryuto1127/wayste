## Communication Style
- Match the language you use (English or Japanese)
- Avoid technical jargon; use plain, natural language
- If technical terms or concepts come up, explain what they mean in simple terms
- **Project name spelling: always lowercase `wayste`** — never `Wayste`, `WAYSTE`, or `WaYsTe`. This applies even at the start of a sentence and in headings/titles. The name is a stylized lowercase wordmark. Don't uppercase it visually either — no CSS `text-transform: uppercase`/`uppercase` utility on elements that render the wordmark (e.g. eyebrow labels).

### Kiosk End-Users (Office/Airport Workers)
- The kiosk's UI must also use simple, non-technical language
- Every screen, button label, and message should be clear to someone with no waste-sorting knowledge
- Avoid ambiguity; assume users glance for ~2 seconds and move on

## Project Vision
- AI waste sorting kiosk: fixed downward camera near bins detects items and displays the correct bin on screen in real-time
- End goal: zero-effort sorting guidance in offices, airports, and public spaces
- Constraints: browser-first inference (minimize server costs/latency); camera sees only waste + hands, never faces
- Current phase: demo on Vercel, no production deployment yet — planning pilot tests
- Privacy (decided, implemented): the kiosk classifies 100% on-device by default — items YOLO can't confidently resolve become `needs_review` locally; no frame is sent to a cloud AI. The legacy GPT escalation survives only behind `NEXT_PUBLIC_CLOUD_FALLBACK=1` for pilot experiments (cloud-vs-local comparison). Next: introduce a local VLM as "Tier 1.5" to raise automation on items YOLO can't resolve, then delete the cloud path entirely.

## Tech Stack
- TypeScript / Next.js 16 (App Router) / React 19 / Tailwind CSS v4
- YOLO26m FP16 (ONNX Runtime Web) — browser object detection. Deployed: 5-class demo model (`demo5_v1.onnx`, 39 MB, mAP50 0.92) — plastic_bottle/can/paper_cup/plastic_cup/battery. The prior 15-class model stays as `15class_v1.onnx` + `yolo-rules.15class.json`
- OpenAI `gpt-5.4-mini` — legacy cloud fallback, OFF by default; only used when `NEXT_PUBLIC_CLOUD_FALLBACK=1` (pilot experiments). Default kiosk path resolves low-confidence items as `needs_review` on-device
- Upstash Redis (REST) / Vercel Blob / Vercel Serverless + Cron
- Zod v4 / Jest v30 (575 tests, 30 suites) / EN+JA i18n (181 keys/locale)

## Commands
    npm run dev      # Dev server (Turbopack)
    npm run build    # Production build
    npm test         # 575 Jest tests, 30 suites
    npm run lint     # ESLint

## Routes
- `/` — Public marketing landing page (`app/page.tsx`); 10-section product introduction with embedded demos. Light theme, scrollable.
- `/kiosk` — Kiosk display for physical devices (`app/kiosk/page.tsx`); requires valid `kiosk_session` cookie or middleware redirects to `/kiosk/unlock`. Wrapped in dark fixed-viewport layout via `app/kiosk/layout.tsx`.
- `/kiosk/unlock` — One-time kiosk auth flow; sets the long-lived `kiosk_session` cookie then redirects to `/kiosk`.
- `/review`, `/insights` — Admin pages, gated by HTTP Basic Auth via middleware.

## Architecture
- `app/api/classify/route.ts` — Classification endpoint (GPT-5.4 mini, gated behind `NEXT_PUBLIC_CLOUD_FALLBACK=1` — returns 403 otherwise; overrides, Blob upload); supports single + batch (up to 4 items) formats
- `lib/threshold-config.ts` — Master sensitivity (0–1) → all detection/inference thresholds; auto-calibration aware
- `lib/frame-analyzer.ts` — CV pipeline: 120x120 canvas, ~33fps, background subtraction, auto-calibration, multi-blob detection (top 4 with per-blob sharpness/contrast/skin/saturation scoring)
- `lib/yolo-inference.ts` — YOLO26m wrapper (Tier 1: 15 custom waste classes; instant result when confidence ≥ YOLO_FALLBACK_THRESHOLD = 0.725 at default sensitivity, derived as `lerp(0.80, 0.65, sensitivity)` in `lib/threshold-config.ts`); WebGPU primary, WASM fallback
- `lib/rgb-material-analyzer.ts` — RGB/texture analysis helpers (HSV color, transparency, metallicity, bbox aspect ratio, LBP texture, class-name refinement). The classify route *can* accept a `MaterialHint` and fold it into the GPT prompt + log, but the live kiosk path does not currently produce one — `analyzeMaterial()` is unwired and `KioskDisplay` sends no hint; only `refineClassName` / `computeLbpTexture` / `detectMetallicFromLuminance` are unit-tested. Treat this module as scaffolding, not an active stage.
- `lib/inference-backend.ts` — 2-tier orchestration (YOLO → GPT-5.4 mini); sequential model startup with `overallReady` gate
- `lib/vlm-shadow.ts` — Cloud-vs-local shadow comparison (pilot mechanism, off by default). When `LOCAL_VLM_ENDPOINT` is set, `/api/classify` also runs a local/candidate VLM on each escalated frame (server-side, non-blocking, inside the existing background logging) and records `localModel` on the pilot-log entry; aggregated by `computeModelComparison()` and shown on `/insights`. Offline benchmarking harness lives in `lib/benchmark/` (+ `scripts/bench/`)
- `lib/detection-tracker.ts` — 常時検出モードの時間方向トラッカー(IoU追跡、N-of-M確定、ヒステリシス、遮蔽コースティング、すり替え投票、置きっぱなし抑制)。site config `detectionMode: "continuous"` で有効化、`showDetectionOverlay` でアノテーション表示(`components/LiveDetectionView.tsx` が1画面構成のライブビューを描画)
- `lib/unknown-object.ts` — 語彙外フォールバック: 低確信度YOLO枠(主・カメラ移動に強い)+CVブロブ(副・固定カメラ時のみ、全画面変動時は自動停止)を `unknown_object` 合成検出としてトラッカーに注入 → needs_review行き。背景ベースライン・顔ベト・静止ゲートで誤発火を抑制
- `lib/vlm-client.ts` — Tier 1.5 VLMクライアント(site config `localVlm`)。endpoint は `"browser"`(transformers.js+WebGPUでページ内実行、`lib/vlm-browser.ts`+Worker、既定モデル onnx-community/Qwen3.5-0.8B-ONNX)、ループバックURL(ローカルランタイム)、`"server"`(同一オリジン `/api/vlm` プロキシ経由 — 実エンドポイントはサーバーenv `VLM_ENDPOINT`/`VLM_MODEL`、送信前に顔ゲート+サーバー側再チェック)のみ許可。needs_reviewトラックの切り出しを判定し、既存の昇格経路でカードを確定に更新
- `lib/waste-rules-core.ts` — Word-boundary pattern matching + override engine (browser-safe)
- `lib/waste-rules.ts` — Site config loader + GPT prompt builder (5-min cache)
- `components/KioskDisplay.tsx` — State machine: loading → idle → object_detected → classifying → result → cooldown; multi-item blob-to-detection matching (up to 4), three-way routing (YOLO match above threshold → instant result, YOLO match below threshold → on-device `needs_review`, unmatched+object → on-device `needs_review`, unmatched+noise → discard). With `NEXT_PUBLIC_CLOUD_FALLBACK=1` the two `needs_review` branches call GPT-5.4 mini instead (legacy pilot mode; also re-enables the result-state API sweep)
- `config/sites/*.json` — Per-site waste rules (4 presets: japan-office, office-hq, airport, pilot; japan-office is the default)
- `middleware.ts` — Admin auth (HTTP Basic Auth → 4-hour session cookie), kiosk session gate on `/kiosk` and `/kiosk/unlock`, and per-request nonce-based CSP

## Rules & Conventions
- Local-first, local-only by default: all classification happens in the browser (YOLO); items it can't confidently resolve become `needs_review` on-device. Never add a cloud call to the default kiosk path — the GPT fallback exists only behind `NEXT_PUBLIC_CLOUD_FALLBACK=1` for pilot experiments
- Overrides use word-boundary matching ("cup" matches "paper cup" but not "cupcake"); Japanese patterns match by substring (「蛍光灯」 matches 「蛍光灯（直管）」)
- Site stream ids must either match yolo-rules.json streams (recyclable/burnable/plastic/special) or define `yoloStreamMap` in the site JSON — otherwise the on-device instant path silently degrades to needs_review
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
- 検出モードは2系統: gated(背景差分ゲート+オンデマンドYOLO)と continuous(常時YOLO ~10fps+時間方向トラッカー)。背景差分は人通過・カメラ揺れに弱く「検出しない/誤検出」の両方の不安定さの根源だったため、デモ・展示用途は continuous を使う。誤検出対策は閾値調整ではなく時間方向の一貫性(多数決+ヒステリシス)で行う
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
