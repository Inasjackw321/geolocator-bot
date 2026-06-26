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
- **Multi-pass refinement** — re-examines the photo up to **100 times**,
  alternating between **two** models, each pass critiquing the last and pushing
  for a *more specific* location. Stops early once the guess stops moving.
- **Streamed analysis** — the model's reasoning appears live as it thinks, with a
  "pass X/Y" progress indicator
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

**The Settings dropdown is populated live from OpenRouter** — it queries
`openrouter.ai/api/v1/models` and shows only models that currently accept image
input, so you never get stuck on a rotated/retired ID. Free ones are marked
**— free**; hit **↻** to refresh the list.

> ⚠️ The model **must support image input** — this app sends photos. Text-only
> models (e.g. `openrouter/owl-alpha`) return *"No endpoints found that support
> image input."* The live list filters those out for you.
>
> Tip: prefer one marked **— free**. If a particular free model still errors with
> "no endpoints support image input," its free endpoint is temporarily text-only —
> just pick a different image-capable one from the list.
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
- **Refinement loop:** pick **Model A** and **Model B** in Settings plus a number
  of passes (1–100, default 100). Pass 1 produces an initial analysis; each later
  pass shows the previous answer to the *other* model and asks it to verify,
  correct, and localize more precisely. The loop stops early when the coordinates
  settle (within ~5 km for 3 passes in a row), and on rate limits it backs off and
  keeps the best result so far. **Note:** free models are rate-limited, so a high
  pass count can be slow or hit daily caps — lower it if you just want a quick
  answer.

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
