# 🌍 Geolocator Bot

A cross-platform **desktop app** that uses Claude's vision capabilities to inspect a
photograph and reason about *where on Earth it was taken* — like a GeoGuessr expert
crossed with an OSINT analyst.

Drop in a photo, and the bot examines signage, language, architecture, vegetation,
road markings, the sun's position, license plates, and more, then returns a
structured location estimate with its reasoning and confidence.

## Features

- **Drag & drop, paste, or browse** for a photo (JPEG, PNG, WebP, GIF)
- **Streamed analysis** — the model's reasoning appears live as it thinks
- Structured output: best guess, confidence, estimated coordinates, the clues used,
  alternative possibilities, and what would narrow it down
- Optional free-text context/question to steer the analysis
- Pick your model (Opus 4.8 / Sonnet 4.6 / Haiku 4.5)
- API key stored locally on your machine — nothing is sent anywhere except the
  Anthropic API

## Requirements

- [Node.js](https://nodejs.org/) 18+ (developed on Node 22)
- An Anthropic API key — create one at [console.anthropic.com](https://console.anthropic.com)

## Getting started

```bash
npm install
npm start
```

On first launch, click **⚙ Settings**, paste your Anthropic API key, choose a model,
and save. Then drop a photo in and click **Locate photo**.

## How it works

```
renderer (UI)  ──IPC──▶  main process  ──HTTPS──▶  Anthropic Messages API
  index.html              main.js                  (Claude vision, streaming)
  renderer.js             preload.js
  styles.css
```

- The **renderer** is sandboxed (`contextIsolation: true`, `nodeIntegration: false`)
  and talks to the main process only through a small, named bridge in `preload.js`.
- The **main process** holds the API key and makes the streaming
  `client.messages.stream(...)` call, sending Claude a base64 image plus a
  geolocation system prompt. Text deltas are forwarded to the UI as they arrive.
- The default model is `claude-opus-4-8`; change it anytime in Settings.

## Packaging a standalone app (optional)

[`electron-builder`](https://www.electron.build/) is pre-configured in
`package.json`. To build an installer for your platform:

```bash
npm install --save-dev electron-builder
npm run dist
```

## Privacy & key storage

Your API key and model choice are saved in plaintext in Electron's per-user
`settings.json` (under the OS app-data directory). This is convenient for a personal
desktop tool but is **not** an encrypted secret store — treat the machine
accordingly. The selected photo is sent to the Anthropic API for analysis and is not
stored or transmitted anywhere else.

## Disclaimer

Location estimates are AI inferences from visual clues and can be wrong. Use them as
a starting point, not as authoritative geolocation.
