# Infographic Studio — Claude Code Project File

> CRITICAL: Read this before making any changes.

---

## Source of Truth

**The production code lives in TWO places:**

| Location | Path | Role |
|----------|------|------|
| **aledparry.com** (CANONICAL) | `cpshomes/components/SocialEditor.jsx` | Next.js component, Vercel deploy |
| **This repo** (STANDALONE) | `studio_v2.jsx` | CDN/Babel build, GitHub Pages |

**Before editing `studio_v2.jsx`, ALWAYS check if `SocialEditor.jsx` is newer:**
```bash
wc -l ~/Documents/GitHub/aledparry.com/cpshomes/components/SocialEditor.jsx
wc -l ~/Documents/GitHub/cpshomes/socialeditor/studio_v2.jsx
```
If the aledparry.com version is larger or newer, copy it first.

**After major edits, sync BOTH files.**

---

## Project Overview

**Name:** Infographic Studio (Social Editor)
**Client:** CPS Homes
**GitHub:** https://github.com/aledprysparry/socialeditor
**Live (GitHub Pages):** https://aledprysparry.github.io/socialeditor/
**Live (Vercel):** https://www.aledparry.com/app/cpshomes/socialeditor
**API (current):** aledparry.com/api/studio (Vercel Blob) + /api/ai (Claude proxy)
**API (future):** PMA backend on Railway — /api/studio/* routes (PostgreSQL + Prisma)
**PMA Backend repo:** https://github.com/aledprysparry/pma-backend (private)

---

## Tech Stack

| Layer | Technology |
|---|---|
| UI framework | React 18 (CDN UMD standalone / Next.js in aledparry.com) |
| JSX transpile | Babel Standalone (in-browser, standalone only) |
| Rendering | HTML5 Canvas API (all graphics drawn programmatically) |
| Animation export | MediaRecorder API → transparent VP9 WebM |
| MOV conversion | FFmpeg.wasm (loaded lazily, ~31MB) |
| Storage (current) | localStorage + Vercel Blob backup |
| Storage (future) | PostgreSQL via PMA backend (Railway) |
| AI analysis | Claude API via server-side proxy (/api/ai) |
| Zip export | JSZip |
| Cue sheets | docx library |
| Fonts | Google Fonts (DM Sans, Lora, + 10 others) |

---

## File Structure

```
socialeditor/
  index.html              ← Standalone production build (single file)
  studio_v2.jsx           ← React source — derived from SocialEditor.jsx
  CLAUDE.md               ← This file
  README.md               ← Team-facing docs
  sync.sh                 ← Legacy sync script
  premiere-automation/
    plugin/
      manifest.json       ← UXP plugin manifest (Premiere Pro 25+)
      index.html          ← Panel UI
      css/panel.css       ← Dark SaaS-style theme
      js/panel.js         ← 4-path bridge detection, auto-load engine
      host/engine.jsx     ← ExtendScript 3-stage engine
    examples/
      example-manifest.json
```

---

## Build Process (standalone)

```
studio_v2.jsx → index.html:
1. Remove "use client"
2. Replace `import { useState... } from "react"` → `const { useState... } = React`
3. Remove ES module imports (docx, JSZip, FFmpeg) — loaded via CDN
4. Remove `export default App`
5. Wrap in HTML boilerplate with CDN scripts:
   React 18, ReactDOM 18, Babel Standalone, JSZip 3.10.1, docx 9.5.0
```

---

## Features (~5100 lines)

- SRT/video/audio → AI analysis → 15 graphic templates
- CPS Homes brand: cream backgrounds, serif fonts (DM Sans/Lora), wavy textures
- Templates: myth, reality, title, rule_number, key_point, fact_box, speech_bubble, stat, timeline, landlord_ask, tenant_ask, lower_third, advice, subscribe, endboard
- Fallback renderer for unrecognised templates (never transparent)
- 4 caption styles (karaoke, pop-in, tiktok, fade)
- Poster Studio tab (AI-generated social media posters)
- Live video preview with safe zone overlays
- Brand dropdown + edit drawer + keyboard shortcuts
- Export: PNG, WebM, PNG sequences, Premiere Ready zip, MOV, docx cue sheets
- AI Social Media Review (per-slide verdicts with apply-all)
- Font loading: waitForFonts() polls until brand fonts confirmed loaded
- previewAll: single state update (not loop)
- Template save: writes template + templateHint
- Smart text wrapping (balanced lines, break-before-conjunction)

---

## Premiere Automation (UXP + ExtendScript hybrid)

**Architecture:** UXP panel = UI control layer. ExtendScript = all Premiere DOM manipulation. Never move import/timeline logic into UXP.

**Engine features:** two-strategy import, bin isolation, deterministic naming, frame continuity checks, track collision detection, per-item audit trail, hard stop on unverified imports, named track mapping.

**Panel:** 4-path bridge detection (premierepro.host → uxp.host → uxp.script → CEP), auto-loads engine on first call, retry failed items.

---

## Important Constraints

- **No bundler, no npm** for standalone — everything runs via CDN
- **No `export default`** — Babel standalone doesn't support ES module exports
- **No `window.confirm()` or `window.prompt()`** — blocked in many environments
- **No `fetch(dataURL)`** — blocked by CSP; use `canvas.toBlob()` for PNG export
- **API_BASE** auto-detects github.io → uses absolute URLs to aledparry.com
- **CORS** enabled on aledparry.com API routes for github.io origin
- **PNG sequence duration** uses `g.duration` from AI analysis (not hardcoded)
- **Recording FPS** is 25 (not 30)

---

## Migration Plan (in progress)

Moving from localStorage/Vercel Blob to PMA backend (PostgreSQL + Prisma on Railway):

1. ✅ PMA backend has studio routes: /api/studio/brands, /api/studio/projects, /api/studio/exports
2. ✅ GitHub repo created: aledprysparry/pma-backend
3. ⏳ Railway deployment in progress
4. ⬜ Wire SocialEditor.jsx to call PMA API (~20 lines change)
5. ⬜ Remove localStorage persistence
6. ⬜ Logo upload to R2 instead of base64
