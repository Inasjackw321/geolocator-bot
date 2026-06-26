'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// This app talks to OpenRouter (https://openrouter.ai), which exposes an
// OpenAI-compatible Chat Completions API. We call it with native fetch + SSE
// streaming, so there is no SDK dependency.
// ---------------------------------------------------------------------------
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Local settings (API key + model), stored in the OS-standard userData dir.
// Plaintext file readable by the local user — fine for a personal desktop
// tool, but not a secret store. See README.
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(next) {
  const merged = { ...readSettings(), ...next };
  fs.writeFileSync(settingsPath(), JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

// Default model. `openrouter/owl-alpha` is an OpenRouter stealth/alpha model
// (free while in preview). If it's retired or doesn't accept images, switch to a
// free vision model in Settings — e.g. google/gemini-2.0-flash-exp:free.
const DEFAULT_MODEL = 'openrouter/owl-alpha';

const MEDIA_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const SYSTEM_PROMPT = `You are an expert geolocation analyst — think of a world-class GeoGuessr player combined with an OSINT investigator. You are given a single photograph and must reason carefully about where on Earth it was most likely taken.

Work through the visible evidence methodically. Consider, where applicable:
- Language and script on any signs, shopfronts, posters, or graffiti
- Architecture, building materials, roof styles, and urban vs. rural layout
- Vegetation, tree species, crops, and overall climate/biome
- Road infrastructure: which side of the road traffic drives on, road markings, signage shape/color, bollards, guardrails
- Vehicles and license plate shapes/colors
- Utility poles, wiring style, street furniture, fire hydrants, manhole covers
- Terrain, geology, mountains, coastline, and the position/angle of the sun
- People's clothing, and any cultural or commercial brand cues
- Camera/photo characteristics (e.g. Google Street View artifacts) if present

Be explicit about your reasoning and your uncertainty. Do not pretend to be more certain than the evidence allows. If the image lacks strong clues, say so.

Respond in Markdown using exactly this structure:

## Best guess
A one-line answer: most likely country, region, and (if supportable) city or specific area.

## Confidence
One of: Very low / Low / Medium / High / Very high — followed by a brief reason.

## Estimated coordinates
Your best latitude/longitude estimate (decimal degrees) with a rough radius of uncertainty, or "Not determinable" if there genuinely isn't enough to go on.

## Clues I used
A bulleted list. For each clue, name what you saw and what it implies.

## Other possibilities
2–4 plausible alternative locations and why they're in the running.

## What would narrow it down
Briefly, what additional detail or angle would most increase your certainty.

If the user provides extra context or a specific question, take it into account.`;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: '#0f1220',
    title: 'Geolocator Bot',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC: settings
// ---------------------------------------------------------------------------
ipcMain.handle('settings:get', () => {
  const s = readSettings();
  return {
    hasApiKey: Boolean(s.apiKey),
    model: s.model || DEFAULT_MODEL,
  };
});

ipcMain.handle('settings:save', (_evt, { apiKey, model }) => {
  const next = {};
  if (typeof apiKey === 'string' && apiKey.trim()) next.apiKey = apiKey.trim();
  if (typeof model === 'string' && model.trim()) next.model = model.trim();
  const saved = writeSettings(next);
  return { hasApiKey: Boolean(saved.apiKey), model: saved.model || DEFAULT_MODEL };
});

// ---------------------------------------------------------------------------
// IPC: image picking — returns base64 data the renderer can preview and reuse
// ---------------------------------------------------------------------------
ipcMain.handle('image:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a photo to locate',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return loadImage(result.filePaths[0]);
});

function loadImage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mediaType = MEDIA_TYPES[ext];
  if (!mediaType) throw new Error(`Unsupported image type: ${ext || 'unknown'}`);
  const data = fs.readFileSync(filePath).toString('base64');
  return { name: path.basename(filePath), mediaType, data };
}

// ---------------------------------------------------------------------------
// IPC: analyze — streams the model's response back to the renderer via SSE
// ---------------------------------------------------------------------------
ipcMain.handle('analyze:start', async (evt, payload) => {
  const { mediaType, data, note } = payload || {};
  const settings = readSettings();

  if (!settings.apiKey) {
    return { ok: false, error: 'No API key set. Open Settings and paste your OpenRouter API key.' };
  }
  if (!data || !mediaType) {
    return { ok: false, error: 'No image provided.' };
  }

  const model = settings.model || DEFAULT_MODEL;
  const sender = evt.sender;
  const dataUrl = `data:${mediaType};base64,${data}`;

  const userText =
    note && note.trim()
      ? `Analyze this photo and determine where it was taken.\n\nAdditional context from me: ${note.trim()}`
      : 'Analyze this photo and determine where it was taken.';

  const body = {
    model,
    stream: true,
    max_tokens: 4096,
    stream_options: { include_usage: true },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  };

  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
        // Optional OpenRouter attribution headers.
        'HTTP-Referer': 'https://github.com/Inasjackw321/geolocator-bot',
        'X-Title': 'Geolocator Bot',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok || !resp.body) {
      return { ok: false, error: await describeHttpError(resp) };
    }

    const usage = await pumpStream(resp.body, (delta) => {
      if (!sender.isDestroyed()) sender.send('analyze:delta', delta);
    });

    return {
      ok: true,
      model,
      usage: usage
        ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens }
        : null,
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// Parse an OpenAI-compatible SSE stream, forwarding text deltas. Returns the
// final usage object if the provider included one.
async function pumpStream(stream, onDelta) {
  const decoder = new TextDecoder();
  let buffer = '';
  let usage = null;

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });

    // SSE events are separated by blank lines; process complete lines only.
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);

      if (!line || line.startsWith(':')) continue; // keep-alive comment
      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return usage;

      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // partial/non-JSON line, skip
      }

      const delta = json.choices && json.choices[0] && json.choices[0].delta;
      if (delta && typeof delta.content === 'string' && delta.content) {
        onDelta(delta.content);
      }
      if (json.usage) usage = json.usage;
    }
  }
  return usage;
}

async function describeHttpError(resp) {
  let detail = '';
  try {
    const j = await resp.json();
    detail = (j && j.error && (j.error.message || j.error)) || '';
  } catch {
    /* non-JSON body */
  }
  switch (resp.status) {
    case 401:
      return 'Authentication failed — check that your OpenRouter API key is correct.';
    case 402:
      return 'Payment required — this model needs credits, or your free quota is exhausted.';
    case 403:
      return detail || 'Request blocked (403). The model may require privacy settings to be enabled in your OpenRouter account.';
    case 404:
      return `Model not found (404). The free model ID may have changed — pick another in Settings. ${detail}`.trim();
    case 429:
      return 'Rate limited — free models have tight limits. Wait a bit and try again, or pick another model.';
    default:
      if (resp.status >= 500) return `OpenRouter service error (${resp.status}). Try again shortly. ${detail}`.trim();
      return detail || `Request failed (${resp.status}).`;
  }
}
