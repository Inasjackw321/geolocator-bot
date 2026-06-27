# 🌍 Geolocator Bot

A cross-platform **desktop app** that uses a vision AI model to inspect a
photograph and reason about *where on Earth it was taken* — like a GeoGuessr expert
crossed with an OSINT analyst.

Drop in a photo, and the bot examines signage, language, architecture, vegetation,
road markings, the sun's position, license plates, and more, then returns a
structured location estimate with its reasoning and confidence.

Powered by **[Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers)**
— a vision model (GLM-4.5V) looks at the photo and a text reasoning model
(GLM-5.2) deduces the location.

## Just open it

You need [Node.js](https://nodejs.org/) installed once. Then:

- **Any OS, the Python way:** run **`python run.py`** (or double-click `run.py`)
- **macOS:** double-click **`start.command`**
- **Windows:** double-click **`start.bat`**
- **Linux:** run **`./start.sh`**

All of these do the same thing — install everything on first run and open the app. After that it
opens straight away. First launch, click **⚙ Settings**, paste your
[Hugging Face token](https://huggingface.co/settings/tokens) (with the
*“Make calls to Inference Providers”* permission), and Save.

> macOS may warn the first time you open `start.command` — right-click it,
> choose **Open**, then **Open** again to allow it.

## Features

- **Multiple photos of the same place** — drag/drop, paste, or browse up to 8
  images; the more angles and details you give it, the better it can narrow down.
  Thumbnails show what's queued; click any **×** to remove one.
- **4-stage narrowing pipeline** — **GLM-4.5V** (vision) first observes all the
  photos broadly (text/language, architecture, nature/climate, roads, vehicles &
  brands, landmarks/sun), then takes a **closer look** hunting for the specifics
  that pin a city/district/street (exact signage, house numbers, plate codes,
  chains). Then **GLM-5.2** (reasoning) makes an **initial deduction** with
  candidates and finally **commits** to the single most specific location.
  (GLM-5.2 is text-only, so it reasons over the descriptions, not the images.)
- **Streamed analysis** — each step appears live, with a "Step X/4" progress
  indicator
- **Result map** — drops a pin at the estimated coordinates (interactive
  OpenStreetMap, plus a one-click "Open in Google Maps" link)
- Structured output: best guess, confidence, estimated coordinates, the clues used,
  alternative possibilities, and what would narrow it down
- Optional free-text context/question to steer the analysis
- Token stored locally on your machine — the photo only goes to Hugging Face

## Requirements

- [Node.js](https://nodejs.org/) 18+ (developed on Node 22)
- A Hugging Face token with the **“Make calls to Inference Providers”** permission —
  create one at [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens).
  Inference Providers usage is billed through Hugging Face (there's a small monthly
  free allowance for signed-in users; heavier use needs credits).

## Getting started

```bash
npm install
npm start
```

On first launch, click **⚙ Settings**, paste your Hugging Face token, confirm the
models, and save. Then drop a photo in and click **Locate photo**.

## Models

Two models work together via **Hugging Face Inference Providers** (set both in
Settings — any Inference-Providers-served model ID works):

| Role | Default | Notes |
| --- | --- | --- |
| **Vision model** | [`zai-org/GLM-4.5V`](https://huggingface.co/zai-org/GLM-4.5V) | Must be image-capable (`image-text-to-text`). Sees the photo and answers the observation questions. |
| **Reasoning model** | [`zai-org/GLM-5.2`](https://huggingface.co/zai-org/GLM-5.2) | Text-only. Reasons over the vision model's written answers to pick the most specific location. |

> If a model 404s, it isn't currently served by an Inference Provider — pick another
> from [huggingface.co/models](https://huggingface.co/models?inference_provider=all)
> (filter by **Inference Providers**; for the vision slot also filter task =
> **image-text-to-text**). You can pin a provider with a suffix, e.g.
> `zai-org/GLM-4.5V:novita`.

## How it works

```
renderer (UI)  ──IPC──▶  main process  ──HTTPS──▶  HF Inference Providers router
  index.html              main.js                  (OpenAI-compatible, streaming SSE)
  renderer.js             preload.js                router.huggingface.co/v1/chat/completions
  styles.css
```

- The **renderer** is sandboxed (`contextIsolation: true`, `nodeIntegration: false`)
  and talks to the main process only through a small, named bridge in `preload.js`.
- The **main process** holds the token and POSTs to the HF router (OpenAI-compatible
  Chat Completions), parsing the streamed SSE response and forwarding text deltas to
  the UI. No SDK — just native `fetch`, so the app has **no runtime dependencies**.
- **Four-step flow:** (1) the **vision** model (`zai-org/GLM-4.5V`) gets all the
  photos + the six observation topics and describes them; (2) it looks again,
  prompted to extract the most location-specific details; (3) the **reasoning**
  model (`zai-org/GLM-5.2`) deduces candidate locations from that text (no images);
  (4) it commits to the single most specific spot and emits the final structured
  report + `GEO: <lat>, <lng>` line. The app parses that line and drops a pin on a
  bundled **Leaflet + OpenStreetMap** map. Any `<think>` reasoning is hidden from
  the displayed answer.
- **Rate-limit handling:** on a `429`/`5xx` the app honors the server's
  `Retry-After` header (or backs off 3→6→12→24→48s, up to 5 retries) and shows a
  "waiting Ns" status. If you keep getting limited, wait a minute or add credits at
  [huggingface.co/settings/billing](https://huggingface.co/settings/billing).
- Your token and model choices are saved once in `settings.json` and reused on
  every launch.

## Packaging a standalone app (optional)

[`electron-builder`](https://www.electron.build/) is pre-configured in
`package.json`. To build an installer for your platform:

```bash
npm install --save-dev electron-builder
npm run dist
```

## Privacy & key storage

Your Hugging Face token and model choices are saved in plaintext in Electron's
per-user `settings.json` (under the OS app-data directory). This is convenient for a
personal desktop tool but is **not** an encrypted secret store — treat the machine
accordingly. The selected photo is sent to Hugging Face (and the Inference Provider
it routes to) for analysis and is not stored or transmitted anywhere else by this app.

## Disclaimer

Location estimates are AI inferences from visual clues and can be wrong. Use them as
a starting point, not as authoritative geolocation.
