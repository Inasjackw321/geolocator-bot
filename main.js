'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// This app talks to Hugging Face Inference Providers, whose router exposes an
// OpenAI-compatible Chat Completions API. We call it with native fetch + SSE
// streaming, so there is no SDK dependency. Auth uses a Hugging Face token
// (hf_...) from https://huggingface.co/settings/tokens.
// ---------------------------------------------------------------------------
const ROUTER_URL = 'https://router.huggingface.co/v1/chat/completions';

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

// VISION model — looks at the photo and answers the observation questions.
// Must be image-capable (image-text-to-text). GLM-4.5V is live on HF Inference
// Providers. (huggingface.co/zai-org/GLM-4.5V)
const DEFAULT_MODEL = 'zai-org/GLM-4.5V';

// REASONING model — does the final synthesis from the textual observations.
// GLM-5.2 is text-only, so it never receives the image; it reasons over the
// vision model's written answers. (huggingface.co/zai-org/GLM-5.2)
const DEFAULT_REASONING_MODEL = 'zai-org/GLM-5.2';

// Sanitize a stored model ID for Hugging Face. Old OpenRouter settings used a
// ":free" suffix, which HF mis-reads as a provider ("provider 'free' is not
// valid"); treat those as stale and fall back to the HF default. Real HF
// provider pins (e.g. "zai-org/GLM-4.5V:novita") are left intact.
function cleanModelId(id, fallback) {
  if (typeof id !== 'string') return fallback;
  const t = id.trim();
  if (!t || /:free$/i.test(t)) return fallback;
  return t;
}

const MEDIA_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// A vision model (GLM-4.5V) answers all the observation questions in ONE call;
// then a reasoning model (GLM-5.2) synthesises a final location from the answers.
const INTERVIEW_SYSTEM =
  'You are an expert geolocation analyst — a world-class GeoGuessr player combined with an OSINT investigator. ' +
  'Reason concretely and specifically from the available evidence and your world knowledge. ' +
  'Be willing to name specific countries, regions, cities, and districts. Note your uncertainty, but do not refuse to commit.';

// One prompt that asks every observation question at once (keeps it to a single
// API call instead of one per question — far gentler on free-tier rate limits).
const OBSERVE_PROMPT = `Examine this photograph carefully and report every clue that could help locate where it was taken. Work through each of these:

1. Text & language — read and transcribe any visible text (signs, shopfronts, posters, license plates, graffiti); identify the language, script, and what region it points to.
2. Architecture & built environment — building styles, materials, roof shapes, window styles, and whether it looks urban, suburban, or rural.
3. Nature & climate — vegetation and any identifiable plant/tree species, terrain, geology, soil colour, sky, and the apparent climate/biome.
4. Roads & infrastructure — which side of the road traffic drives on, lane markings, road-sign shapes/colours, bollards, guardrails, utility poles and wiring.
5. Vehicles, plates & brands — vehicle types, license-plate shape/colour/format, and any visible brand names or shop chains.
6. Landmarks, sun & terrain — recognisable landmarks, mountains, coastlines, the sun's position/shadows, and any distinctive geographic features.

Be concrete and specific, and name candidate countries/regions where you can. This step is observation only — describe what you see; do not give the final single answer yet.`;

const REPORT_FORMAT = `## Best guess
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

Finally, after everything above, output one last line in EXACTLY this format so an app can place a pin on a map — decimal degrees, nothing else on the line:
GEO: <latitude>, <longitude>
If you genuinely cannot estimate coordinates, output:
GEO: none`;

const SYNTHESIS_PROMPT =
  'Based ONLY on the observations above, determine the most specific location this photo was taken, weighing the strongest clues most heavily and discarding weak ones. ' +
  'Respond in Markdown using EXACTLY this structure:\n\n' +
  REPORT_FORMAT;

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
    model: cleanModelId(s.model, DEFAULT_MODEL),
    reasoningModel: cleanModelId(s.reasoningModel, DEFAULT_REASONING_MODEL),
  };
}

ipcMain.handle('settings:get', () => settingsView(readSettings()));

ipcMain.handle('settings:save', (_evt, { apiKey, model, reasoningModel }) => {
  const next = {};
  if (typeof apiKey === 'string' && apiKey.trim()) next.apiKey = apiKey.trim();
  if (typeof model === 'string' && model.trim()) next.model = model.trim();
  if (typeof reasoningModel === 'string' && reasoningModel.trim()) {
    next.reasoningModel = reasoningModel.trim();
  }
  return settingsView(writeSettings(next));
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
    return { ok: false, error: 'No token set. Open Settings and paste your Hugging Face token (hf_…).' };
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
      error: `Your token contains an invalid character (${JSON.stringify(bad.char)}) at position ${bad.index + 1}. This usually happens when copy-paste converts a hyphen "-" into a dash like "–" or "—". Open Settings and re-paste the token as plain text from huggingface.co/settings/tokens.`,
    };
  }

  const model = cleanModelId(settings.model, DEFAULT_MODEL); // vision model (sees the photo)
  const reasoningModel = cleanModelId(settings.reasoningModel, DEFAULT_REASONING_MODEL); // text-only synthesis
  const sender = evt.sender;
  const dataUrl = `data:${mediaType};base64,${data}`;
  const send = (channel, msg) => {
    if (!sender.isDestroyed()) sender.send(channel, msg);
  };

  const extra =
    note && note.trim() ? `\n\nKeep in mind this context from the user: ${note.trim()}` : '';

  // Two calls total (keeps provider rate limits happy):
  //   1) one vision call (GLM-4.5V) that asks ALL the observation questions
  //   2) one reasoning call (GLM-5.2) over those observations (text-only)
  const total = 2;
  let lastUsage = null;

  const onRetry = (label, model, info) =>
    send('analyze:note', `${label}: rate-limited, waiting ${info.waitSec}s (retry ${info.attempt})…`);

  try {
    // --- 1) Vision observation (all questions in one prompt) -------------
    send('analyze:pass', { pass: 1, total, label: 'Examining the photo', model });
    const obs = await callWithRetry({
      apiKey,
      model,
      messages: [
        { role: 'system', content: INTERVIEW_SYSTEM },
        {
          role: 'user',
          content: [
            { type: 'text', text: OBSERVE_PROMPT + extra },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      maxTokens: 1400,
      onDelta: (d) => send('analyze:delta', d),
      onRetry: (info) => onRetry('Examining the photo', model, info),
    });
    if (!obs.ok) return { ok: false, error: obs.error };
    lastUsage = obs.usage || lastUsage;

    // --- 2) Reasoning synthesis (GLM-5.2, text-only) ---------------------
    send('analyze:pass', { pass: 2, total, label: 'Final reasoning', final: true, model: reasoningModel });
    const synthUser =
      'A vision analyst examined a photograph and reported these observations:\n\n' +
      obs.text +
      '\n\n' +
      SYNTHESIS_PROMPT;

    const final = await callWithRetry({
      apiKey,
      model: reasoningModel,
      messages: [
        { role: 'system', content: INTERVIEW_SYSTEM },
        { role: 'user', content: synthUser },
      ],
      maxTokens: 2000,
      onDelta: (d) => send('analyze:delta', d),
      onRetry: (info) => onRetry('Final reasoning', reasoningModel, info),
    });
    if (!final.ok) return { ok: false, error: final.error };
    lastUsage = final.usage || lastUsage;

    return {
      ok: true,
      model: `${model} + ${reasoningModel}`,
      passesDone: total,
      usage: lastUsage
        ? { input_tokens: lastUsage.prompt_tokens, output_tokens: lastUsage.completion_tokens }
        : null,
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const MAX_RETRIES = 5;

// One streamed model call, retried on rate-limit / transient server errors,
// honoring the server's Retry-After when present.
async function callWithRetry({ apiKey, model, messages, maxTokens, onDelta, onRetry }) {
  let result = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    result = await callModel({ apiKey, model, messages, maxTokens, onDelta });
    if (result.ok) return result;
    const transient = result.status === 429 || (result.status >= 500 && result.status < 600);
    if (transient && attempt < MAX_RETRIES) {
      // Prefer the server's Retry-After; otherwise exponential backoff.
      const backoff = Math.min(60, 3 * Math.pow(2, attempt)); // 3,6,12,24,48s
      const waitSec = result.retryAfter ? Math.min(60, result.retryAfter) : backoff;
      if (onRetry) onRetry({ attempt: attempt + 1, waitSec });
      await sleep(waitSec * 1000);
      continue;
    }
    return result;
  }
  return result;
}

// One streamed model call. Returns { ok, text, usage } or { ok:false, status, retryAfter, error }.
async function callModel({ apiKey, model, messages, maxTokens, onDelta }) {
  const body = {
    model,
    stream: true,
    max_tokens: maxTokens || 1200,
    messages,
  };
  const resp = await fetch(ROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) {
    return {
      ok: false,
      status: resp.status,
      retryAfter: parseRetryAfter(resp.headers),
      error: await describeHttpError(resp),
    };
  }
  let text = '';
  const usage = await pumpStream(resp.body, (d) => {
    text += d;
    if (onDelta) onDelta(d);
  });
  return { ok: true, text, usage };
}

// Read Retry-After (seconds, or an HTTP date) or X-RateLimit-Reset (ms epoch).
function parseRetryAfter(headers) {
  const ra = headers.get('retry-after');
  if (ra) {
    const secs = parseInt(ra, 10);
    if (Number.isFinite(secs)) return secs;
    const when = Date.parse(ra);
    if (Number.isFinite(when)) return Math.max(0, Math.ceil((when - Date.now()) / 1000));
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset) {
    const ms = parseInt(reset, 10);
    if (Number.isFinite(ms)) return Math.max(0, Math.ceil((ms - Date.now()) / 1000));
  }
  return null;
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
      return 'Authentication failed — check your Hugging Face token (it needs the "Make calls to Inference Providers" permission). Re-create one at huggingface.co/settings/tokens.';
    case 402:
      return 'Payment required — your Hugging Face Inference Providers credits are exhausted. Add a payment method / credits in huggingface.co/settings/billing.';
    case 403:
      return detail || 'Request blocked (403). Your token may lack Inference Providers permission, or the model is gated — accept its terms on its model page.';
    case 404:
      return `Model not found, or not served by any Inference Provider (404). Check the model ID in Settings (e.g. zai-org/GLM-4.5V). ${detail}`.trim();
    case 429:
      return (
        'Rate limited by Hugging Face Inference Providers even after several retries. ' +
        'Wait a minute and try again, or add credits at huggingface.co/settings/billing to raise your limits. ' +
        (detail ? `(${detail})` : '')
      ).trim();
    default:
      if (resp.status >= 500) return `Inference provider error (${resp.status}). Try again shortly. ${detail}`.trim();
      return detail || `Request failed (${resp.status}).`;
  }
}
