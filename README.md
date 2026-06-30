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
- **Highlight clues** — click a photo to open the editor and drag boxes over signs,
  license plates, shopfronts, or landmarks. Each box is cropped at full resolution
  and sent to the AI as a zoomed-in close-up with a "look here" note, so it can read
  small details it would otherwise miss.
- **Animated, polished UI** — live progress bar across the steps, smooth reveals,
  and a spinner while it works.
- **4-stage narrowing pipeline** — **GLM-4.5V** (vision) first observes all the
  photos broadly (text/language, architecture, nature/climate, roads, vehicles &
  brands, landmarks/sun), then takes a **closer look** hunting for the specifics
  that pin a city/district/street (exact signage, house numbers, plate codes,
  chains). Then **GLM-5.2** (reasoning) makes an **initial deduction** with
  candidates and finally **commits** to the single most specific location.
  (GLM-5.2 is text-only, so it reasons over the descriptions, not the images.)
- **Web search for clues** — the app looks up the signs, business names, streets
  and landmarks the model reads, using **OpenStreetMap** (geocoding addresses to
  coordinates), **Wikipedia**, and **DuckDuckGo** — all free, no API key. This
  works even with local models (the app does the searching, then feeds the results
  to the reasoning step). Toggle it off in Settings; only the extracted *text* is
  searched, never your photos.
- **Streamed analysis** — each step appears live, with a "Step X/5" progress
  indicator
- **Multiple ranked pins** — the model lists its **best guess first**, then up to
  three alternative locations worth showing. The app drops a **numbered pin per
  candidate**, with the best guess shown as a larger, pulsing primary pin (and the
  alternatives dimmed). The map **auto-fits to all the pins**, and a clean
  **candidate list** beneath it animates in — click any row to fly the map to that
  pin and open its popup.
- **Live activity timeline** — instead of dumping raw text, the analysis shows as a
  tidy **step-by-step timeline** (spinner → ✓ for each stage), with each step's
  output collapsible. Web searches appear as their own cards with the query and its
  map/web hits, so you can watch exactly what it's looking up.
- **Geocoded pins + a self-check when unsure** — instead of trusting the model's
  guessed lat/long (often just a city centroid), the app looks each candidate's
  place up with **two free geocoders (OpenStreetMap Nominatim + Photon)** and ranks
  matches by specificity (house/street beats city). If the best guess only resolves
  to a coarse level, it **searches the web again for that exact place** and refines
  the pin if a more precise match for the *same* place turns up nearby — so the
  pin lands on the street, not the city centre, without an unrelated business
  hijacking it. Interactive map + one-click "Open in Google Maps".
- Structured output: best guess, confidence, estimated coordinates, the clues used,
  alternative possibilities, and what would narrow it down
- Optional free-text context/question to steer the analysis
- Token stored locally on your machine — the photo only goes to Hugging Face

## Run it locally with Ollama (no token, free, private)

Because the app speaks the OpenAI-compatible Chat Completions API, it can point at
a local [Ollama](https://ollama.com) server instead of the cloud:

1. Install Ollama and pull a **vision** model and a **reasoning** model, e.g.:
   ```bash
   ollama pull qwen2.5vl
   ollama pull qwen2.5
   ```
   (Ollama serves automatically on `http://localhost:11434`.)
2. In the app: **⚙ Settings** → click **Ollama (local)** → it fills the endpoint
   (`http://localhost:11434/v1`) and local model names. Leave the token blank → Save.

No API key, no rate limits, fully offline. **Caveat:** local models are smaller
(7B–11B) than the cloud GLM models, so geolocation is less sharp, and a machine
without a decent GPU will be slow (this app makes 4 calls per run).

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
  (4) it commits to the most specific spot and emits the final structured report
  plus a machine-readable `CANDIDATES:` block — best guess first, then up to three
  alternatives, each `place | lat, lng | reason`. The app parses that block,
  geocodes each place, and drops a numbered pin per candidate on a bundled
  **Leaflet + OpenStreetMap** map. Any `<think>` reasoning and the raw `CANDIDATES`
  lines are hidden from the displayed answer.
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
