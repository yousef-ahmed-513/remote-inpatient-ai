#!/bin/bash
# Remote Inpatient AI - one-click local demo for macOS / Linux.
# Run:  bash start-demo.sh   (first run installs everything, then opens http://localhost:3210)
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install the LTS version from https://nodejs.org (or: brew install node) and run this again."
  exit 1
fi
[ -f .env ] || cp .env.example .env
[ -d node_modules ] || npm install || { echo "Installation failed."; exit 1; }
( sleep 15; (command -v open >/dev/null && open http://localhost:3210) || xdg-open http://localhost:3210 ) >/dev/null 2>&1 &
npm run dev
