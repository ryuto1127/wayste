# Recycling Buddy — Smart Waste Sorting Kiosk

A real-time waste sorting guidance system for public spaces. A camera and display are installed in front of waste bins. Users hold an item in front of the camera, and the system instantly tells them which bin to use.

Built for airports, schools, food courts, campuses, malls, and public buildings.

## How It Works

1. A person approaches the waste station
2. They hold an item in front of the camera
3. The system identifies the item using computer vision (OpenAI GPT-5.4 Mini)
4. The screen shows which bin to use — in large, readable text with color coding
5. If confidence is low, the system says so honestly

The system combines **live item recognition** with **site-specific waste sorting rules**, so the same item might get different guidance depending on the local facility's capabilities.

## Setup

### Prerequisites

- Node.js 18+
- An OpenAI API key
- A webcam (built-in or USB)

### Install

```bash
npm install
```

### Configure

```bash
cp .env.local.example .env.local
```

Edit `.env.local` and add your OpenAI API key:

```
OPENAI_API_KEY=sk-your-key-here
SITE_ID=default
```

### Run

```bash
npm run dev
```

Open http://localhost:3000 in a browser. Allow camera access when prompted.

For a production kiosk, run the browser in full-screen/kiosk mode (e.g., `chromium --kiosk http://localhost:3000`).

### Build for Production

```bash
npm run build
npm run start
```

## Site-Specific Waste Rules

The system uses JSON configuration files in `config/sites/` to define waste sorting rules per deployment location.

- `config/sites/default.json` — General-purpose 4-stream rules (Recycling, Compost, Landfill, Special Disposal)
- `config/sites/airport.json` — Airport terminal example with a Liquids stream

To create rules for a new site:

1. Copy `config/sites/default.json` to `config/sites/your-site.json`
2. Edit the streams, overrides, and site name
3. Set `SITE_ID=your-site` in `.env.local`

Each site config defines:
- **Streams**: The available waste bins (name, color, description of what goes in each)
- **Overrides**: Item-specific rules that take precedence over the AI's classification (e.g., "coffee cups go to landfill because of plastic lining")
- **Default stream**: Fallback when uncertain (usually landfill)

## Architecture

```
Browser (Kiosk Display)
  ├── Camera feed (getUserMedia)
  ├── Frame capture every 1.5s
  ├── State machine: idle → detecting → result → idle
  └── Large, high-contrast UI

Server (Next.js API Route)
  ├── /api/classify — receives base64 frame
  ├── OpenAI GPT-5.4 Mini — identifies the item
  ├── Waste rules engine — applies site-specific overrides
  └── Returns: item name, bin, confidence, reasoning
```

### Key Design Decisions

- **Stability requirement**: The system requires 2 consecutive matching classifications before showing a result, preventing flickering
- **Honest uncertainty**: Low-confidence results show a clear warning. Very low confidence shows "Item Not Recognized" instead of a wrong guess
- **Site-configurable rules**: The AI identifies what the object *is*; the rules engine determines where it *goes* at this location
- **No external dependencies for camera**: Uses native browser getUserMedia API
- **GPT-5.4 Mini for speed**: Uses a fast, cost-efficient vision model for real-time classification

## Project Structure

```
├── app/
│   ├── api/classify/route.ts    # Classification API endpoint
│   ├── globals.css              # Global styles
│   ├── layout.tsx               # Root layout (kiosk-optimized)
│   └── page.tsx                 # Main entry point
├── components/
│   ├── CameraFeed.tsx           # Camera capture with getUserMedia
│   ├── ConfidenceMeter.tsx      # Visual confidence indicator
│   ├── IdleScreen.tsx           # Attract screen when idle
│   ├── KioskDisplay.tsx         # Main orchestrator + state machine
│   └── ResultDisplay.tsx        # Disposal guidance display
├── config/
│   └── sites/
│       ├── default.json         # Default waste rules
│       └── airport.json         # Airport example
└── lib/
    ├── types.ts                 # Shared TypeScript types
    └── waste-rules.ts           # Rules engine
```

## Future Improvements

### Better Real-Time Vision
- **Edge inference**: Run a lightweight object detection model (YOLO/MobileNet) locally on the kiosk hardware for instant pre-screening, using the cloud API only for ambiguous items
- **Multi-item detection**: Detect and classify multiple items simultaneously with bounding boxes
- **Motion/presence detection**: Use frame differencing to detect when someone approaches, rather than running the camera loop continuously
- **Optimized frame selection**: Only send frames when motion stabilizes (item is being held still), reducing API calls

### Physical Deployment
- **Directional arrows**: Show arrows pointing toward the physical bin (left/right/center) based on the bin layout at each site
- **Hardware integration**: Connect to physical indicators (LED strips on bins, audio cues) via serial/GPIO
- **Offline fallback**: Cache common classifications locally so the system works during network outages
- **Usage analytics**: Track classification counts, confidence distributions, and common items per site
- **Accessibility**: Audio output, multi-language support, high-contrast modes for different lighting conditions
- **Vandal-resistant UI**: No interactive elements that can be abused; auto-recovery from all error states

### Site-Specific Rules
- **Admin panel**: Web interface for site operators to edit waste rules without touching JSON files
- **Regional rule databases**: Pre-built rule sets for different municipalities/countries
- **Seasonal overrides**: Handle temporary changes (e.g., holiday packaging rules)
- **Feedback loop**: Allow staff to flag incorrect classifications, building a correction dataset over time
# recycling-buddy-kiosk
# recycling-buddy-kiosk
