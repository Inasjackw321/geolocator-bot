'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
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

// Default model. MUST be vision-capable, since this app sends photos. Free and
// strong for geolocation. If it 404s (free IDs rotate), pick another vision model
// in Settings (openrouter.ai/models, filter Free + Image input).
const DEFAULT_MODEL = 'google/gemini-2.0-flash-exp:free';

// How many refinement passes to run by default, and the hard ceiling.
const DEFAULT_PASSES = 100;
const MAX_PASSES = 100;

function clampInt(v, lo, hi, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

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
The MOST SPECIFIC location the evidence honestly supports. Always give the country and region; push further to city, then neighbourhood/district, then a specific street, road, or landmark whenever the clues justify it. Be as precise as the evidence allows — but never invent specificity you can't defend.

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

If the user provides extra context or a specific question, take it into account.

Finally, after everything above, output one last line in EXACTLY this format so an app can place a pin on a map — decimal degrees, nothing else on the line:
GEO: <latitude>, <longitude>
If you genuinely cannot estimate coordinates, output:
GEO: none`;

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
function settingsView(s) {
  return {
    hasApiKey: Boolean(s.apiKey),
    model: s.model || DEFAULT_MODEL,
    modelB: s.modelB || s.model || DEFAULT_MODEL,
    passes: clampInt(s.passes, 1, MAX_PASSES, DEFAULT_PASSES),
  };
}

ipcMain.handle('settings:get', () => settingsView(readSettings()));

ipcMain.handle('settings:save', (_evt, { apiKey, model, modelB, passes }) => {
  const next = {};
  if (typeof apiKey === 'string' && apiKey.trim()) next.apiKey = apiKey.trim();
  if (typeof model === 'string' && model.trim()) next.model = model.trim();
  if (typeof modelB === 'string' && modelB.trim()) next.modelB = modelB.trim();
  if (passes !== undefined) next.passes = clampInt(passes, 1, MAX_PASSES, DEFAULT_PASSES);
  return settingsView(writeSettings(next));
});

// ---------------------------------------------------------------------------
// IPC: live model discovery — ask OpenRouter which models currently accept
// images, so the user never depends on a hardcoded ID that has rotated away.
// ---------------------------------------------------------------------------
function isImageCapable(m) {
  const a = m.architecture || {};
  if (Array.isArray(a.input_modalities) && a.input_modalities.includes('image')) return true;
  if (typeof a.modality === 'string' && a.modality.includes('image')) return true;
  return false;
}

function isFreeModel(m) {
  const p = m.pricing || {};
  return parseFloat(p.prompt || '0') === 0 && parseFloat(p.completion || '0') === 0;
}

ipcMain.handle('models:list', async () => {
  try {
    const headers = { 'Content-Type': 'application/json' };
    const s = readSettings();
    if (s.apiKey) {
      const key = String(s.apiKey).trim();
      if (!firstNonAsciiChar(key)) headers.Authorization = `Bearer ${key}`;
    }
    const resp = await fetch('https://openrouter.ai/api/v1/models', { headers });
    if (!resp.ok) {
      return { ok: false, error: `Could not load model list (HTTP ${resp.status}).` };
    }
    const json = await resp.json();
    const models = (json.data || [])
      .filter(isImageCapable)
      .map((m) => ({ id: m.id, name: m.name || m.id, free: isFreeModel(m) }))
      // free first, then alphabetical
      .sort((a, b) => (a.free === b.free ? a.name.localeCompare(b.name) : a.free ? -1 : 1));
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// Open a URL in the user's real browser (only http/https).
ipcMain.handle('open:external', (_evt, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
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

  // HTTP header values must be printable ASCII. A common copy-paste mishap turns
  // a hyphen in the key into a dash (– or —), which makes fetch throw a cryptic
  // "ByteString" error. Catch it here with a clear, fixable message.
  const apiKey = String(settings.apiKey).trim();
  const bad = firstNonAsciiChar(apiKey);
  if (bad) {
    return {
      ok: false,
      error: `Your API key contains an invalid character (${JSON.stringify(bad.char)}) at position ${bad.index + 1}. This usually happens when copy-paste converts a hyphen "-" into a dash like "–" or "—". Open Settings and re-paste the key as plain text from openrouter.ai/keys.`,
    };
  }

  const modelA = settings.model || DEFAULT_MODEL;
  const modelB = settings.modelB || modelA;
  const models = modelB && modelB !== modelA ? [modelA, modelB] : [modelA];
  const passes = clampInt(settings.passes, 1, MAX_PASSES, DEFAULT_PASSES);
  const sender = evt.sender;
  const dataUrl = `data:${mediaType};base64,${data}`;
  const send = (channel, msg) => {
    if (!sender.isDestroyed()) sender.send(channel, msg);
  };

  const baseTask =
    note && note.trim()
      ? `Determine where this photo was taken, as specifically as the evidence allows.\n\nAdditional context from me: ${note.trim()}`
      : 'Determine where this photo was taken, as specifically as the evidence allows.';

  let best = ''; // most refined analysis so far
  let prevGeo = null; // last parsed coordinates
  let stable = 0; // consecutive passes with ~unchanged coordinates
  let passesDone = 0;
  let lastUsage = null;

  try {
    for (let i = 0; i < passes; i++) {
      const model = models[i % models.length];
      const messages = i === 0
        ? initialMessages(dataUrl, baseTask)
        : refineMessages(dataUrl, baseTask, best, i + 1);

      send('analyze:pass', { pass: i + 1, total: passes, model });

      // One pass, with retry on rate-limit / transient server errors.
      let result = null;
      for (let attempt = 0; attempt <= 3; attempt++) {
        result = await callModel({ apiKey, model, messages, onDelta: (d) => send('analyze:delta', d) });
        if (result.ok) break;
        const transient = result.status === 429 || (result.status >= 500 && result.status < 600);
        if (transient && attempt < 3) {
          send('analyze:pass', { pass: i + 1, total: passes, model, retry: attempt + 1 });
          await sleep(1500 * (attempt + 1));
          continue;
        }
        break;
      }

      if (!result.ok) {
        // If we already have at least one good pass, stop gracefully and keep it.
        if (passesDone > 0) {
          send('analyze:note', `Stopped early at pass ${i + 1}: ${result.error}`);
          break;
        }
        return { ok: false, error: result.error };
      }

      passesDone = i + 1;
      best = result.text;
      lastUsage = result.usage || lastUsage;

      // Convergence check: if coordinates barely move for a few passes, stop.
      const geo = parseGeo(result.text);
      if (geo) {
        if (prevGeo && haversineKm(geo, prevGeo) < 5) stable += 1;
        else stable = 0;
        prevGeo = geo;
        if (stable >= 3 && i >= 2) {
          send('analyze:note', `Converged after ${i + 1} passes.`);
          break;
        }
      }
    }

    return {
      ok: true,
      model: models.join(' + '),
      passesDone,
      usage: lastUsage
        ? { input_tokens: lastUsage.prompt_tokens, output_tokens: lastUsage.completion_tokens }
        : null,
    };
  } catch (err) {
    if (passesDone > 0) {
      send('analyze:note', `Stopped: ${err.message || err}`);
      return { ok: true, model: models.join(' + '), passesDone, usage: null };
    }
    return { ok: false, error: err.message || String(err) };
  }
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function initialMessages(dataUrl, baseTask) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: baseTask },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ];
}

function refineMessages(dataUrl, baseTask, previous, passNumber) {
  const instruction =
    `${baseTask}\n\n` +
    `This is refinement pass ${passNumber}. Below is the latest assessment of THIS SAME photo (possibly from a different analyst). ` +
    `Re-examine the image yourself from scratch. Verify each claim against what you can actually see, correct anything wrong or overstated, ` +
    `and push to localize MORE precisely — narrow from country → region → city → district → street/landmark, but only as far as the evidence honestly supports. ` +
    `If you cannot improve on it, keep it. Output the full structured report again with your improved answer, ending with the GEO line.\n\n` +
    `--- Latest assessment ---\n${previous}`;
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'text', text: instruction },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ];
}

// One streamed model call. Returns { ok, text, usage } or { ok:false, status, error }.
async function callModel({ apiKey, model, messages, onDelta }) {
  const body = {
    model,
    stream: true,
    max_tokens: 2000,
    stream_options: { include_usage: true },
    messages,
  };
  const resp = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/Inasjackw321/geolocator-bot',
      'X-Title': 'Geolocator Bot',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) {
    return { ok: false, status: resp.status, error: await describeHttpError(resp) };
  }
  let text = '';
  const usage = await pumpStream(resp.body, (d) => {
    text += d;
    if (onDelta) onDelta(d);
  });
  return { ok: true, text, usage };
}

// Parse the "GEO: lat, lng" line the model is asked to emit. Returns {lat,lng} or null.
function parseGeo(text) {
  const m = text.match(/^\s*GEO:\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/im);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
  return null;
}

// Rough great-circle distance in km, for the convergence check.
function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

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

// Returns the first character that can't go in an HTTP header (outside printable
// ASCII 0x20–0x7E), or null if the string is header-safe.
function firstNonAsciiChar(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return { index: i, code: c, char: s[i] };
  }
  return null;
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
