'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// This app speaks the OpenAI-compatible Chat Completions API (native fetch +
// SSE streaming, no SDK). The endpoint base URL is configurable:
//   • Hugging Face Inference Providers (cloud): https://router.huggingface.co/v1
//   • Ollama (local):                           http://localhost:11434/v1
// Local endpoints need no token.
// ---------------------------------------------------------------------------
const DEFAULT_BASE_URL = 'https://router.huggingface.co/v1';

function isLocalUrl(u) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(String(u || ''));
}

function chatEndpoint(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '') + '/chat/completions';
}

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

// A 4-step pipeline: the vision model (GLM-4.5V) observes the photo(s) broadly,
// then takes a closer "narrowing" look; the reasoning model (GLM-5.2) then makes
// an initial deduction and finally commits to the most specific location.
const INTERVIEW_SYSTEM =
  'You are an expert geolocation analyst — a world-class GeoGuessr player combined with an OSINT investigator — examining one or more photographs of the SAME place. ' +
  'Reason concretely and specifically from the available evidence and your world knowledge. ' +
  'Be willing to name specific countries, regions, cities, districts, and streets. Note your uncertainty, but do not refuse to commit.';

// Step 1 (vision): broad observation across all submitted photos.
const OBSERVE_PROMPT = `You are shown one or more photographs of the SAME location. Examine ALL of them together and report every clue that could help locate where they were taken. Work through each of these:

1. Text & language — read and transcribe any visible text (signs, shopfronts, posters, license plates, graffiti); identify the language, script, and what region it points to.
2. Architecture & built environment — building styles, materials, roof shapes, window styles, and whether it looks urban, suburban, or rural.
3. Nature & climate — vegetation and any identifiable plant/tree species, terrain, geology, soil colour, sky, and the apparent climate/biome.
4. Roads & infrastructure — which side of the road traffic drives on, lane markings, road-sign shapes/colours, bollards, guardrails, utility poles and wiring.
5. Vehicles, plates & brands — vehicle types, license-plate shape/colour/format, and any visible brand names or shop chains.
6. Landmarks, sun & terrain — recognisable landmarks, mountains, coastlines, the sun's position/shadows, and any distinctive geographic features.

Note which photo each clue comes from if it matters, and call out anything consistent across photos. Be concrete and specific, and name candidate countries/regions where you can. This step is observation only — do not give the final single answer yet.`;

// Step 2 (vision): a closer, targeted look to narrow the location down.
const VISION_NARROW_PROMPT = `Now look again at the photo(s) even more closely, hunting specifically for details that NARROW the location down to a city, district, or exact street. Extract the highest-value specifics you can actually read or see:
- Exact transcriptions of any text: street names, building/house numbers, shop and business names, phone numbers (and their country/area-code format), postal codes.
- Distinctive logos, brand chains, transit liveries, or institutional signage.
- License-plate region codes, stickers, or colours; bus/taxi markings.
- Unique architectural, signage, or streetscape details that could be matched to a specific place.
List the concrete specifics you find. If something is partially legible, give your best reading and say it's uncertain. Still do not give the final answer.

At the very end, output a line starting with "SEARCHES:" followed by up to 5 web-search queries (one per line) that would best help identify the exact place. PRIORITISE the names of businesses, shops, restaurants, hotels, or brands visible on signs — each combined with your best guess of the city, region, or country (e.g. "Joe's Pizza Lyon France", "Hotel Splendide Bordeaux"). Also include street name + city, and any landmark names. Make each query specific and self-contained (don't rely on the others). If nothing is worth searching, write "SEARCHES: none".`;

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

// Step 3 (reasoning): initial deduction from the observations, with candidates.
const DEDUCE_PROMPT =
  'Reason step by step from these observations toward a location. Give your current best country → region → city, and list 2–4 candidate specific locations (district/street/landmark) with the concrete evidence for and against each. Do not finalise yet — this is your working deduction.';

// Step 4 (reasoning): commit to the single most specific defensible location.
const FINAL_PROMPT =
  'Now narrow down and COMMIT. Choose the single most specific location the evidence honestly supports — push to neighbourhood/district, then a specific street, road, or landmark whenever the clues justify it — resolving between your candidates above. ' +
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
  const baseUrl = s.baseUrl || DEFAULT_BASE_URL;
  return {
    hasApiKey: Boolean(s.apiKey),
    baseUrl,
    local: isLocalUrl(baseUrl),
    model: cleanModelId(s.model, DEFAULT_MODEL),
    reasoningModel: cleanModelId(s.reasoningModel, DEFAULT_REASONING_MODEL),
    webSearch: s.webSearch !== false, // default on
  };
}

ipcMain.handle('settings:get', () => settingsView(readSettings()));

ipcMain.handle('settings:save', (_evt, { apiKey, baseUrl, model, reasoningModel, webSearch }) => {
  const next = {};
  if (typeof apiKey === 'string' && apiKey.trim()) next.apiKey = apiKey.trim();
  if (typeof baseUrl === 'string' && baseUrl.trim()) next.baseUrl = baseUrl.trim();
  if (typeof model === 'string' && model.trim()) next.model = model.trim();
  if (typeof reasoningModel === 'string' && reasoningModel.trim()) {
    next.reasoningModel = reasoningModel.trim();
  }
  if (typeof webSearch === 'boolean') next.webSearch = webSearch;
  return settingsView(writeSettings(next));
});

// Open a URL in the user's real browser (only http/https).
ipcMain.handle('open:external', (_evt, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});

// ---------------------------------------------------------------------------
// IPC: image picking — allows multiple files; returns an array of base64 images
// ---------------------------------------------------------------------------
ipcMain.handle('image:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose one or more photos of the same place',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return [];
  return result.filePaths.map(loadImage);
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
  const { note } = payload || {};
  const images = Array.isArray(payload && payload.images) ? payload.images : [];
  const settings = readSettings();

  const baseUrl = settings.baseUrl || DEFAULT_BASE_URL;
  const local = isLocalUrl(baseUrl);
  const endpoint = chatEndpoint(baseUrl);

  // Local endpoints (Ollama) don't need a token; cloud ones do.
  if (!settings.apiKey && !local) {
    return { ok: false, error: 'No token set. Open Settings and paste your Hugging Face token (hf_…), or point the endpoint at a local Ollama server.' };
  }
  if (images.length === 0 || images.some((im) => !im || !im.data || !im.mediaType)) {
    return { ok: false, error: 'No image provided.' };
  }

  // HTTP header values must be printable ASCII. A common copy-paste mishap turns
  // a hyphen in the key into a dash (– or —), which makes fetch throw a cryptic
  // "ByteString" error. Catch it here with a clear, fixable message.
  const apiKey = settings.apiKey ? String(settings.apiKey).trim() : '';
  const bad = apiKey ? firstNonAsciiChar(apiKey) : null;
  if (bad) {
    return {
      ok: false,
      error: `Your token contains an invalid character (${JSON.stringify(bad.char)}) at position ${bad.index + 1}. This usually happens when copy-paste converts a hyphen "-" into a dash like "–" or "—". Open Settings and re-paste the token as plain text from huggingface.co/settings/tokens.`,
    };
  }

  const model = cleanModelId(settings.model, DEFAULT_MODEL); // vision model (sees the photos)
  const reasoningModel = cleanModelId(settings.reasoningModel, DEFAULT_REASONING_MODEL); // text-only
  const sender = evt.sender;
  const send = (channel, msg) => {
    if (!sender.isDestroyed()) sender.send(channel, msg);
  };

  // When the local server is unreachable, point the user at the obvious fixes.
  const enrich = (msg) => {
    if (local && /fetch failed|econnrefused|network|failed to fetch|connect|socket/i.test(String(msg || ''))) {
      return `Couldn't reach a local server at ${baseUrl}. Make sure Ollama is running and you've pulled the models — e.g. "ollama pull ${model}" and "ollama pull ${reasoningModel}". (${msg})`;
    }
    return msg;
  };

  const extra =
    note && note.trim() ? `\n\nKeep in mind this context from the user: ${note.trim()}` : '';

  // Image content blocks (all submitted photos) for the vision turns.
  const imageBlocks = images.map((im) => ({
    type: 'image_url',
    image_url: { url: `data:${im.mediaType};base64,${im.data}` },
  }));
  const photoWord = images.length === 1 ? 'photo' : `${images.length} photos`;

  // Pipeline: vision observe → vision narrow → [web search] → reason deduce →
  // reason commit. The web-search step is skipped when disabled in Settings.
  const webEnabled = settings.webSearch !== false;
  const total = webEnabled ? 5 : 4;
  let pass = 0;
  let lastUsage = null;

  const step = async (label, opts) => {
    send('analyze:pass', { pass: ++pass, total, label, model: opts.model, final: opts.final });
    const r = await callWithRetry({
      url: endpoint,
      apiKey,
      model: opts.model,
      messages: opts.messages,
      maxTokens: opts.maxTokens,
      onDelta: (d) => send('analyze:delta', d),
      onRetry: (info) =>
        send('analyze:note', `${label}: rate-limited, waiting ${info.waitSec}s (retry ${info.attempt})…`),
    });
    if (r.ok) lastUsage = r.usage || lastUsage;
    else r.error = enrich(r.error);
    return r;
  };

  try {
    // --- Vision: broad observation across all photos ---------------------
    const visionMessages = [
      { role: 'system', content: INTERVIEW_SYSTEM },
      { role: 'user', content: [{ type: 'text', text: OBSERVE_PROMPT + extra }, ...imageBlocks] },
    ];
    const obs1 = await step(`Examining the ${photoWord}`, {
      model, messages: visionMessages, maxTokens: 1400,
    });
    if (!obs1.ok) return { ok: false, error: obs1.error };
    visionMessages.push({ role: 'assistant', content: obs1.text });

    // --- Vision: closer look to narrow down (re-includes the photos) -----
    visionMessages.push({ role: 'user', content: [{ type: 'text', text: VISION_NARROW_PROMPT }, ...imageBlocks] });
    const obs2 = await step('Looking closer to narrow it down', {
      model, messages: visionMessages, maxTokens: 1200,
    });
    if (!obs2.ok) return { ok: false, error: obs2.error };

    const observations = `${obs1.text}\n\nCloser look — narrowing details:\n${obs2.text}`;

    // --- Web search (app-side; local models can't browse) ----------------
    let webContext = '';
    if (webEnabled) {
      send('analyze:pass', { pass: ++pass, total, label: 'Searching the web for clues' });
      const queries = parseSearches(obs2.text);
      if (queries.length === 0) {
        send('analyze:delta', '_No specific search terms were found in the photos — skipping web search._');
      } else {
        const blocks = [];
        for (const q of queries) {
          send('analyze:delta', `**Searching:** ${q}\n`);
          let r;
          try {
            r = await searchQuery(q);
          } catch {
            r = { query: q, places: [], web: [] };
          }
          let b = `Query: "${q}"\n`;
          for (const pl of r.places) b += `- OpenStreetMap: ${pl.name} (${pl.lat.toFixed(4)}, ${pl.lng.toFixed(4)})\n`;
          for (const w of r.web) b += `- ${w}\n`;
          if (!r.places.length && !r.web.length) b += '- (no results)\n';
          b += '\n';
          send('analyze:delta', b);
          blocks.push(b);
          await sleep(400); // be polite to the free endpoints
        }
        webContext = blocks.join('');
      }
    }

    // --- Reasoning: initial deduction (text-only) ------------------------
    const reasonMessages = [
      { role: 'system', content: INTERVIEW_SYSTEM },
      {
        role: 'user',
        content:
          `A vision analyst examined ${photoWord} of one location and reported:\n\n${observations}` +
          (webContext
            ? `\n\nWeb search results gathered from those clues (use them to verify and pin the location; ignore irrelevant hits):\n\n${webContext}`
            : '') +
          `\n\n${DEDUCE_PROMPT}`,
      },
    ];
    const deduce = await step('Reasoning about candidates', {
      model: reasoningModel, messages: reasonMessages, maxTokens: 1400,
    });
    if (!deduce.ok) return { ok: false, error: deduce.error };
    reasonMessages.push({ role: 'assistant', content: deduce.text });

    // --- Reasoning: commit to the most specific location -----------------
    reasonMessages.push({ role: 'user', content: FINAL_PROMPT });
    const final = await step('Final location', {
      model: reasoningModel, messages: reasonMessages, maxTokens: 2000, final: true,
    });
    if (!final.ok) return { ok: false, error: final.error };

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
async function callWithRetry({ url, apiKey, model, messages, maxTokens, onDelta, onRetry }) {
  let result = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    result = await callModel({ url, apiKey, model, messages, maxTokens, onDelta });
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
async function callModel({ url, apiKey, model, messages, maxTokens, onDelta }) {
  const body = {
    model,
    stream: true,
    max_tokens: maxTokens || 1200,
    messages,
  };
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`; // omitted for local (Ollama)

  let resp;
  try {
    resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (e) {
    // Network/connection failure (e.g. local server not running). Not retryable.
    return { ok: false, status: 0, retryAfter: null, error: e.message || 'Network error' };
  }
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
      return `Model not found (404). For Ollama, pull it first (e.g. "ollama pull llama3.2-vision"); for Hugging Face, check the model ID is served by an Inference Provider. ${detail}`.trim();
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

// ---------------------------------------------------------------------------
// Web search — runs on the app's side (local models can't browse). All free,
// no API key: OpenStreetMap Nominatim (geocoding), Wikipedia, DuckDuckGo.
// ---------------------------------------------------------------------------
const SEARCH_TIMEOUT_MS = 7000;
const SEARCH_UA = 'GeolocatorBot/1.0 (personal desktop geolocation app)';

async function fetchJsonSafe(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { headers: headers || {}, signal: ctrl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;|&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(parseInt(n, 10));
      } catch {
        return '';
      }
    })
    .replace(/\s+/g, ' ')
    .trim();
}

// Pull the "SEARCHES:" query list the vision step is asked to emit.
function parseSearches(text) {
  const m = String(text || '').match(/^[ \t]*SEARCHES:[ \t]*(.*)$/im);
  if (!m) return [];
  const start = text.indexOf(m[0]);
  const tail = text.slice(start + m[0].length);
  const lines = (m[1] + '\n' + tail).split('\n');
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^none$/i.test(line)) break;
    const q = line.replace(/^[-*\d.)\s]+/, '').replace(/^["']|["']$/g, '').trim();
    if (q) out.push(q);
    if (out.length >= 5) break;
  }
  return out;
}

async function geocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=2&q=${encodeURIComponent(q)}`;
  const j = await fetchJsonSafe(url, { 'User-Agent': SEARCH_UA, 'Accept-Language': 'en' });
  if (!Array.isArray(j)) return [];
  return j
    .map((p) => ({ name: p.display_name, lat: parseFloat(p.lat), lng: parseFloat(p.lon) }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

async function wikiSearch(q) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=2&origin=*`;
  const j = await fetchJsonSafe(url);
  const arr = (j && j.query && j.query.search) || [];
  return arr.map((s) => `${s.title}: ${stripHtml(s.snippet)}`);
}

async function ddgInstant(q) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&no_redirect=1&t=geolocatorbot`;
  const j = await fetchJsonSafe(url);
  if (!j) return [];
  const out = [];
  if (j.AbstractText) out.push(`${j.Heading ? j.Heading + ': ' : ''}${j.AbstractText}`);
  for (const t of (Array.isArray(j.RelatedTopics) ? j.RelatedTopics : []).slice(0, 2)) {
    if (t && t.Text) out.push(t.Text);
  }
  return out;
}

function shortHost(u) {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// DuckDuckGo's no-JS HTML results give real organic hits (good for business
// names), unlike the Instant Answer API. Best-effort: degrades to [] on failure.
function decodeDdgHref(href) {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* fall through */
    }
  }
  return href.startsWith('//') ? 'https:' + href : href;
}

async function ddgWebResults(q) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  try {
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'text/html' },
      signal: ctrl.signal,
    });
    if (!r.ok) return [];
    const html = await r.text();
    const titles = [];
    const snippets = [];
    const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = linkRe.exec(html)) && titles.length < 3) {
      titles.push({ url: decodeDdgHref(m[1]), title: stripHtml(m[2]) });
    }
    while ((m = snipRe.exec(html)) && snippets.length < 3) {
      snippets.push(stripHtml(m[1]));
    }
    const out = [];
    for (let i = 0; i < titles.length; i++) {
      const host = shortHost(titles[i].url);
      const snip = snippets[i] ? ` — ${snippets[i]}` : '';
      out.push(`${titles[i].title}${snip}${host ? ` [${host}]` : ''}`);
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Search one query across all providers; returns { query, places[], web[] }.
// Real web results (ddgWebResults) come first — best for business names — then
// Wikipedia, then DuckDuckGo instant answers.
async function searchQuery(q) {
  const [places, web, wiki, ia] = await Promise.all([
    geocode(q),
    ddgWebResults(q),
    wikiSearch(q),
    ddgInstant(q),
  ]);
  return { query: q, places, web: [...web, ...wiki, ...ia].slice(0, 5) };
}
