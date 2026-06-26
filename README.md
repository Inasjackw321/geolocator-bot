# 🌍 Geolocator Bot

A cross-platform **desktop app** that uses a vision AI model to inspect a
photograph and reason about *where on Earth it was taken* — like a GeoGuessr expert
crossed with an OSINT analyst.

Drop in a photo, and the bot examines signage, language, architecture, vegetation,
road markings, the sun's position, license plates, and more, then returns a
structured location estimate with its reasoning and confidence.

Powered by **[OpenRouter](https://openrouter.ai)** — so you can run it on **free**,
vision-capable models.

## Just open it

You need [Node.js](https://nodejs.org/) installed once. Then:

- **Any OS, the Python way:** run **`python run.py`** (or double-click `run.py`)
- **macOS:** double-click **`start.command`**
- **Windows:** double-click **`start.bat`**
- **Linux:** run **`./start.sh`**

All of these do the same thing — install everything on first run and open the app. After that it
opens straight away. First launch, click **⚙ Settings**, paste your free
[OpenRouter API key](https://openrouter.ai/keys), and Save.

> macOS may warn the first time you open `start.command` — right-click it,
> choose **Open**, then **Open** again to allow it.

## Features

- **Drag & drop, paste, or browse** for a photo (JPEG, PNG, WebP, GIF)
- **Question-by-question interview** — instead of one big prompt, the app asks the
  AI a sequence of focused questions (text/language, architecture, nature/climate,
  roads, vehicles & brands, landmarks/sun), then a final synthesis question that
  combines the answers into one *specific* location.
- **Streamed analysis** — each question and its answer appear live, with a
  "Question X/Y" progress indicator
- **Result map** — drops a pin at the model's estimated coordinates and refines it
  live each pass (interactive OpenStreetMap, plus a one-click "Open in Google
  Maps" link)
- Structured output: best guess, confidence, estimated coordinates, the clues used,
  alternative possibilities, and what would narrow it down
- Optional free-text context/question to steer the analysis
- Pick from several **free** vision models on OpenRouter
- API key stored locally on your machine — the photo only goes to OpenRouter

## Requirements

- [Node.js](https://nodejs.org/) 18+ (developed on Node 22)
- A free OpenRouter API key — create one at [openrouter.ai/keys](https://openrouter.ai/keys)

## Getting started

```bash
npm install
npm start
```

On first launch, click **⚙ Settings**, paste your OpenRouter API key, choose a model,
and save. Then drop a photo in and click **Locate photo**.

## Choosing a free model

This app uses OpenRouter's OpenAI-compatible API, so any vision-capable model works.
The Settings dropdown ships with these **free** options:

**The Settings dropdown offers only the two Gemma 4 vision models** — it queries
`openrouter.ai/api/v1/models` live and matches them by name, so it always uses the
correct current ID even if the slug rotates:

| Model | Notes |
| --- | --- |
| `Google: Gemma 4 26B A4B (free)` | Lighter, faster. |
| `Google: Gemma 4 31B (free)` | Larger, a bit stronger. |

Hit **↻** to refresh. Pick whichever you prefer — the whole interview runs on that
one model.
| `qwen/qwen-2.5-vl-72b-instruct:free` | Strong dedicated vision model. |
| `meta-llama/llama-4-maverick:free` | Strong multimodal with good world knowledge. |
| `mistralai/mistral-small-3.2-24b-instruct:free` | Lighter, still vision-capable. |

> **Free model IDs rotate often on OpenRouter.** If one starts returning a 404,
> browse [openrouter.ai/models](https://openrouter.ai/models), filter **Price: Free**
> and **Input: Image**, and pick a current one. (Free tiers also have tighter rate
> limits — a 429 just means wait a moment or switch models.)

## How it works

```
renderer (UI)  ──IPC──▶  main process  ──HTTPS──▶  OpenRouter Chat Completions API
  index.html              main.js                  (OpenAI-compatible, streaming SSE)
  renderer.js             preload.js
  styles.css
```

- The **renderer** is sandboxed (`contextIsolation: true`, `nodeIntegration: false`)
  and talks to the main process only through a small, named bridge in `preload.js`.
- The **main process** holds the API key and POSTs to OpenRouter with a base64 image
  (`image_url` data URL) plus a geolocation system prompt, parsing the streamed SSE
  response and forwarding text deltas to the UI as they arrive. No SDK — just
  native `fetch`, so the app has **no runtime dependencies**.
- The default model is `google/gemini-2.0-flash-exp:free`; change it anytime in
  Settings (must be a vision/image-capable model).
- The model is asked to end its answer with a `GEO: <lat>, <lng>` line; the app
  parses that and drops a pin on a bundled **Leaflet + OpenStreetMap** map. Your
  key is saved once in `settings.json` and reused on every launch.
- **Interview flow:** one model is asked six focused observation questions
  (text/language, architecture, nature/climate, roads, vehicles & brands,
  landmarks/sun) in a single ongoing conversation, then a seventh **synthesis**
  question that merges the answers into the final structured report + `GEO` line —
  seven calls total. On a rate-limit it backs off and retries, keeping earlier
  answers. The image is sent once (on the first question) and stays in context.

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
accordingly. The selected photo is sent to OpenRouter (and the model provider it
routes to) for analysis and is not stored or transmitted anywhere else by this app.

## Disclaimer

Location estimates are AI inferences from visual clues and can be wrong. Use them as
a starting point, not as authoritative geolocation.
