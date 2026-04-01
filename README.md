# Infographic Studio — Social Editor

Hosted at: `capsiynau.com/socialeditor`
Repo: `~/Documents/GitHub/cpshomes/socialeditor/`

## Files

| File | Purpose |
|---|---|
| `index.html` | Self-contained app — upload this to the server |
| `studio_v2.jsx` | React source — edit this in Claude |
| `sync.sh` | One-command sync from Downloads → Git → push |

## Update workflow

1. Make changes in Claude
2. Download `index.html` and `studio_v2.jsx` from the chat
3. Run `./sync.sh` from this folder
4. FTP `index.html` to `public_html/socialeditor/` on the server

## Deploy to server (FTP)

```
Host:     capsiynau.com
Path:     /public_html/socialeditor/index.html
File:     index.html
```

## Running locally (optional)

No build step needed. Just open `index.html` in a browser directly:

```bash
open index.html
```

Or serve it:

```bash
npx serve .
# → http://localhost:3000
```

## Tech stack

- React 18 (CDN, no bundler)
- Babel Standalone (in-browser JSX transpile)
- Canvas API (graphic + caption rendering)
- MediaRecorder API (WebM export)
- localStorage (brand + project persistence)
- Anthropic Claude API (script analysis)
