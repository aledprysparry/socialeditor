# Infographic Studio — Claude Code Project File

> This file gives Claude Code full context on the project.
> Keep it updated as the codebase evolves.

---

## Project Overview

**Name:** Infographic Studio (Capsiynau Social Editor)
**Live URL:** https://capsiynau.com/socialeditor
**Repo:** `~/Documents/GitHub/cpshomes/socialeditor/`
**Client:** Capsiynau — Welsh-language social media production

A browser-based tool that turns video transcripts (SRT files) into:
- Animated infographic graphics (PNG stills + transparent WebM video)
- Animated word-by-word captions (transparent WebM video)
- Premiere Pro cue sheets and XML sequences
- All exportable across three aspect ratios (16:9 / 1:1 / 9:16)

---

## File Structure

```
socialeditor/
  index.html       ← Self-contained production build (single file, 133KB)
  studio_v2.jsx    ← React source — ALL development happens here
  sync.sh          ← One-command: copy from Downloads → git commit → push
  README.md        ← Team-facing docs
  CLAUDE.md        ← This file
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| UI framework | React 18 (CDN UMD, no bundler) |
| JSX transpile | Babel Standalone (in-browser, `type="text/babel"`) |
| Rendering | HTML5 Canvas API (all graphics drawn programmatically) |
| Animation export | MediaRecorder API → transparent VP9 WebM |
| Storage | `localStorage` (brands + projects, no backend) |
| AI analysis | Anthropic Claude API (`claude-sonnet-4-20250514`) |
| Fonts | Google Fonts (Montserrat, Oswald, Bebas Neue, Poppins, Anton, Barlow Condensed, Raleway, Nunito) |
| Hosting | Custom server (Apache/Nginx), single HTML file deployment |

### Important constraints
- **No bundler, no npm** — everything runs in the browser via CDN
- **No `export default`** in the source JSX — Babel standalone doesn't support ES module exports. App is mounted with `ReactDOM.createRoot(...).render(React.createElement(App))`
- **No `window.confirm()` or `window.prompt()`** — blocked in many environments; use custom React modal components instead
- **No `fetch(dataURL)`** — blocked by CSP; use `canvas.toBlob()` for PNG export
- **API key** stored in `localStorage` under key `"anthropic_api_key"` — user sets it via UI panel
- Required headers for direct browser API calls:
  ```js
  "x-api-key": localStorage.getItem("anthropic_api_key"),
  "anthropic-version": "2023-06-01",
  "anthropic-dangerous-direct-browser-access": "true"
  ```

---

## Build Process

The source (`studio_v2.jsx`) and the production file (`index.html`) are different:

```bash
# studio_v2.jsx has:
import { useState, useRef, useEffect, useCallback } from "react";
function App(){ ... }   # NO export default

# index.html wraps it as:
const { useState, useRef, useEffect, useCallback } = React;  # CDN globals
# ... all JSX source ...
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(React.createElement(App));
```

To rebuild `index.html` from `studio_v2.jsx`:

```python
with open('studio_v2.jsx','r') as f:
    jsx = f.read()
jsx = jsx.replace(
    'import { useState, useRef, useEffect, useCallback } from "react";',
    'const { useState, useRef, useEffect, useCallback } = React;'
)
# wrap in HTML boilerplate with CDN scripts
# see sync.sh or ask Claude to rebuild
```

---

## Architecture

### Data Model

```
localStorage
  "infostudio_brands_v1"   → Brand[]
  "infostudio_projects_v1" → Project[]
  "anthropic_api_key"      → string
```

```typescript
Brand {
  id, name, createdAt,
  // colours
  colorPrimary, colorAccent, colorPositive, colorText,
  // typography
  fontFamily, typeScale, lineHeight, headingWeight,
  captionFontSize, captionFontWeight, captionLineHeight,
  captionPosition, captionTextCase, captionBgOpacity,
  captionPillRadius,
  // logo watermark
  logoDataUrl, logoOpacity, logoSize, logoPosition,
  // graphic settings
  cornerRadius, iconStyle,
  // brand assets
  titleCardSeriesName, titleCardTitle, titleCardSubtitle, titleCardStyle,
  endboardCTA, endboardHandles, endboardWebsite, endboardStyle,
}

Project {
  id, brandId, name, createdAt,
  srt,              // raw SRT string
  subtitles,        // parsed subtitle objects
  graphics,         // AI-suggested graphic objects
  selected,         // array of selected graphic indices
  previews,         // {[index]: dataURL} cached previews
  captionStyle,     // "karaoke" | "popin" | "tiktok" | "fade"
  titleCardOverride // null | partial Brand (episode-specific title card)
}
```

### App Navigation

```
App
  ├── Home              # Brand list (left) + Project list (right)
  │     └── ApiKeyPanel # Drops down from header
  ├── BrandEditor       # Full-page brand creation/editing
  │     ├── FontPicker
  │     ├── Typography section (typeScale, lineHeight, headingWeight, captionLineHeight)
  │     ├── Logo watermark uploader
  │     └── BrandAssets (Title Card + Endboard — live canvas preview + PNG export)
  └── ProjectView       # Three-tab project workspace
        ├── TitleCardPanel   # Collapsible, per-episode override of brand title card
        ├── GraphicsTab      # AI analyse → review → preview/animate → export
        ├── CaptionsTab      # Style picker + live canvas preview
        └── ExportTab        # Ratio selector + composite/individual mode + full export
```

---

## Graphic Templates

### Fullscreen (solid background, replaces footage)
| Template | Description |
|---|---|
| `myth` | Red background, X icon, "MYTH" badge, body text |
| `reality` | Teal background, check icon, "REALITY" badge, body text |
| `title` | Dark blue, number ghost, accent bar, headline/sub/body |
| `rule_number` | Dark blue, giant ghost number, "RULE #N" |
| `key_point` | Dark blue, teal top bar, info icon, headline + body |

### Overlay (transparent PNG/WebM, placed over footage)
| Template | Description |
|---|---|
| `fact_box` | Card slides in from right, accent side bar, icon + text |
| `speech_bubble` | White bubble scales in from corner, question icon |
| `stat` | Card slides up from bottom, accent top bar, big number |
| `timeline` | Card slides up, track draws across, dots pop in |

### Brand Assets (generated from Brand settings)
| Asset | Layouts |
|---|---|
| Title Card | `bar` (left accent bar) / `centred` (ghost circle) / `split` (colour block) |
| Endboard | `logo` (centred logo) / `grid` (top bar + CTA buttons) / `minimal` (rule + logo) |

### Portrait-aware layouts (9:16)
The `isPortrait = H > W` flag triggers alternative layouts for:
- `title` → centred instead of left-aligned
- `key_point` → icon centred above, stacked text
- `fact_box` → full-width bottom card, slides up
- `speech_bubble` → wide centred bubble, tail from centre
- `stat` → horizontally centred

---

## Caption Styles

| Style | Effect |
|---|---|
| `karaoke` | All words dim, active word gets teal pill highlight |
| `popin` | Words spring in one by one (scale + bounce) |
| `tiktok` | 3 words at a time, active word highlighted |
| `fade` | Words fade in gently |

**Highlight colour:** `colorPositive` (teal) — NOT `colorAccent`
**Pill corner radius:** controlled by `brand.captionPillRadius` (0 = square, 50 = full pill)

---

## Animation System

### Graphics
- Progress value `0→1` drives entrance animation
- `easeOut(t)` = `1-(1-t)³` — standard deceleration
- `easeBack(t)` = spring overshoot — used for icon scale-in
- `ENT = easeOut(clamp(p*2, 0, 1))` — element entrance
- `TXT = easeOut(clamp((p-0.15)*2.5, 0, 1))` — text delayed slightly

### Captions
- Per-word timing estimated from character-count ratio of SRT line duration
- `estimateWordTimings(words, durationSec)` → `{word, start, end}[]`
- `CLH = brand.captionLineHeight` — line height multiplier
- `PR = brand.captionPillRadius` — pill corner radius in canvas units

### Recording
- `recordGraphic(g, brand, ratio)` → 2-second transparent WebM at 30fps
- `recordCaption(subtitle, brand, style, ratio)` → per-line WebM (duration + 0.15s tail)
- `recordCompositeCaption(subtitles, brand, style, ratio)` → one full-length WebM, all captions timed, transparent between lines
- Uses `MediaRecorder` with `video/webm;codecs=vp9` for alpha support

---

## Export Pipeline

### Per ratio output (16:9 / 1:1 / 9:16)
Prefixed with `16x9_`, `1x1_`, `9x16_`:
- Graphic PNGs (`canvas.toBlob()` — not `toDataURL` + fetch, which is CSP-blocked)
- Caption WebMs (composite OR individual)
- Premiere Pro FCP7 XML sequence
- Graphics cue sheet (TSV)

### Premiere Pro workflow
```
V2 — Fullscreen graphics (PNG, trim to cue sheet duration)
V3 — Overlay graphics (transparent PNG/WebM)
V4 — Captions (composite WebM — one drop, all captions timed)
     OR import XML → auto-places individual WebMs
```

---

## Claude API Usage

**Model:** `claude-sonnet-4-20250514`
**Max tokens:** 2500 (graphics analysis)

**Prompt strategy:** Ask for 10–16 graphics (generous), with explicit per-template placement rules. Over-suggesting is preferred — editor can remove but can't add what wasn't suggested.

**Response format:** JSON array, no markdown fences. Each item:
```json
{
  "id": 1,
  "timestamp": "HH:MM:SS",
  "duration": 4,
  "type": "fullscreen|overlay",
  "template": "myth|reality|title|rule_number|key_point|fact_box|speech_bubble|stat|timeline",
  "content": { ... template-specific fields ... },
  "label": "kebab-case-filename"
}
```

---

## Known Issues / To Do

### Agreed next work
- [ ] **Design language** — agree visual system (palette, icon treatment, type scale) before redesigning templates. Reference images show bold, high-contrast, icon-forward style with yellow/white two-tone text
- [ ] **Specialist diagram templates** — process flow (A→B→C), circular stat (ring diagram), comparison (old vs new side-by-side)
- [ ] **Two-tone text** — yellow keyword in white sentence (per reference images)
- [ ] **Sign-in** — shell is in place (button visible, greyed out). Ready to wire to Supabase / Clerk / Firebase Auth
- [ ] **Per-project endboard override** — same pattern as TitleCardPanel (currently brand-level only)
- [ ] **9:16 graphic layout refinement** — auto-scale works but some templates need purpose-built portrait layouts
- [ ] **Ratio-aware graphic layouts** — v2 feature after design language is agreed

### Technical debt
- Babel Standalone is slow to parse 2200+ lines — consider splitting into multiple `<script type="text/babel">` blocks or migrating to a Vite build
- `IMG_CACHE` for logo images is module-level; cleared on page reload (acceptable for now)
- localStorage has ~5MB limit — logo dataURLs are the main risk; consider IndexedDB for large assets

---

## Deployment

**Server:** Custom (Apache or Nginx), `capsiynau.com`
**Path:** `/public_html/socialeditor/index.html`
**Deploy:** FTP upload single file — no build step, no CI needed

```bash
# Quick local test
open index.html
# or
npx serve . && open http://localhost:3000
```

---

## Development Workflow

1. Make changes in Claude (this conversation or Claude Code)
2. Download `index.html` + `studio_v2.jsx`
3. Run `./sync.sh` — copies files, commits with timestamp, pushes to GitHub
4. FTP `index.html` to server

When making changes, always rebuild `index.html` from `studio_v2.jsx` using the transform described above. Both files must stay in sync.

---

## Conversation History

This project was built entirely in a single Claude.ai conversation starting from a production brief for a Wales housing law explainer video. The conversation covers:

- Production brief review and graphic specification
- Full infographic pipeline (SRT → AI analysis → PNG/WebM → Premiere)
- Caption animator with 4 styles and transparent WebM export
- Brand system with font picker, logo watermark, typography controls
- Title card and endboard brand assets (3 layouts each, all ratios)
- Per-project title card overrides
- Composite caption WebM (single-file Premiere drop)
- Portrait-aware graphic layouts for 9:16
- Animated robot loading state
- API key management UI
- Self-contained HTML deployment
- GitHub repo + sync script setup

Conversation ID: `e88065a9-fc3f-4948-8e7d-96fde4d37820`
