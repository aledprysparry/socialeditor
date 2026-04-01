#!/bin/bash
# ─────────────────────────────────────────────────────────────────
#  Infographic Studio — sync script
#  Run this after downloading the latest files from Claude
#  Usage: ./sync.sh
# ─────────────────────────────────────────────────────────────────

REPO="$HOME/Documents/GitHub/cpshomes/socialeditor"
DOWNLOADS="$HOME/Downloads"

echo "🎬 Infographic Studio sync"
echo "──────────────────────────"

# Copy latest files from Downloads if they exist
for file in "index.html" "studio_v2.jsx"; do
  if [ -f "$DOWNLOADS/$file" ]; then
    cp "$DOWNLOADS/$file" "$REPO/$file"
    echo "✓ Copied $file"
  else
    echo "⚠ $file not found in Downloads — skipping"
  fi
done

# Git commit and push
cd "$REPO" || { echo "✗ Repo folder not found: $REPO"; exit 1; }

git add index.html studio_v2.jsx
git commit -m "chore: update studio build $(date '+%Y-%m-%d %H:%M')"
git push

echo ""
echo "✓ Done — changes pushed to GitHub"
echo "  Upload index.html to capsiynau.com/socialeditor via FTP"
