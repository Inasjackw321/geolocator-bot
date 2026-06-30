#!/usr/bin/env bash
# Double-click this on macOS to open Geolink.
# (On Linux you can run ./start.command or ./start.sh from a terminal.)
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found."
  echo "Install it from https://nodejs.org and then open this again."
  read -r -p "Press Enter to close..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First launch: installing dependencies (this can take a minute)..."
  npm install || { echo "npm install failed."; read -r -p "Press Enter to close..."; exit 1; }
fi

echo "Starting Geolink..."
npm start
