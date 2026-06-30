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

// Geocoding sanity gate (km): an alternative pin is dropped if it ends up more
// than ALT_MAX_KM from the best guess (alternatives for one photo shouldn't be
// on another continent). Whether to trust a geocode over the model's own coords
// is decided by name agreement (geoConsistent), not distance.
const ALT_MAX_KM = 3000;

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

const REPORT_FORMAT = `Use these exact section headings, and under each one write ONLY your actual findings. The parentheses are hints for you — do NOT copy the hint text into your answer, and do not repeat these instructions.

## Best guess
(the single most specific place the evidence supports — name the country and region, then push to city, district, and a specific street/road/landmark wherever the clues justify it)

## Confidence
(one of Very low / Low / Medium / High / Very high, then a one-line reason)

## Estimated coordinates
(best latitude, longitude in decimal degrees with a rough radius, or "Not determinable")

## Clues I used
(a bulleted list — each clue you saw and what it implies)

## Other possibilities
(2–4 plausible alternative locations and why each is in the running)

## What would narrow it down
(briefly, the one extra detail or angle that would most raise your certainty)

Finally, after the report above, output a machine-readable list of map locations. Put the token "CANDIDATES:" on its own line — do NOT place it under a Markdown heading and do NOT wrap it in a code block — then one location per line in EXACTLY this pipe format, nothing else on those lines:
CANDIDATES:
<geocodable place: street or landmark, suburb, city, region, country> | <latitude>, <longitude> | <one short reason>
List your committed best guess FIRST, and make that first line as specific as the report above (down to the street or landmark, not just the city), then up to 3 alternative locations worth showing on a map. If you truly cannot place it, output "CANDIDATES:" then a single line "none | 0, 0 | insufficient evidence".`;

// Step 3 (reasoning): initial deduction from the observations, with candidates.
const DEDUCE_PROMPT =
  'Reason step by step from these observations toward a location. Give your current best country → region → city, and list 2–4 candidate specific locations (district/street/landmark) with the concrete evidence for and against each. Do not finalise yet — this is your working deduction.\n\n' +
  'Then output one line "QUESTION:" containing the single most useful question to ask the user about WHERE this photo was taken — the one whose answer would most help you place it (e.g. "Is this your home area or somewhere you travelled to?", "Which country or region do you believe this is in?", "Roughly what year was this taken?", "Do you know the street or building name?"). Ask exactly one short question about placing the photo. The user may skip it, so always provide one — only write "QUESTION: none" if you are already certain of the exact street address.\n\n' +
  'Then output one line "BESTSOFAR:" with your single most likely place written as a geocodable string (most specific first: landmark or street, suburb, city, region, country).\n\n' +
  'Then output between 1 and 4 lines starting with "VERIFY:" — specific web-search queries (one per line) that would best CONFIRM or rule out your top candidates: the exact landmark, street or business combined with the city and country (e.g. "Pothonggang Park Pyongyang", "Rue Saint-Denis 12 Montréal"). You MUST provide at least one VERIFY query — never write "VERIFY: none". The app will run BESTSOFAR plus these searches and give you the results before you commit, so choose queries whose answers would most change your confidence.';

// Step 4 (reasoning): commit to the single most specific defensible location.
const FINAL_PROMPT =
  'Now narrow down and COMMIT. Choose the single most specific location the evidence honestly supports — push to neighbourhood/district, then a specific street, road, or landmark whenever the clues justify it — resolving between your candidates above. ' +
  'Respond in Markdown using EXACTLY this structure:\n\n' +
  REPORT_FORMAT;

// Follow-up chat: the user keeps talking to correct/refine the location. Reply
// in prose, and emit a fresh CANDIDATES block whenever the location changes.
const FOLLOWUP_PROMPT =
  'The user is continuing the conversation to correct or refine the location. ' +
  'Reply in one or two short sentences of plain prose (no Markdown headings). Use the prior evidence and your world knowledge. ' +
  'IMPORTANT: if the user gives, corrects, or narrows the location in ANY way (for example names a city or country, says "it\'s in Melbourne", points out you picked the wrong place, or asks you to adjust/move/update the pins), you MUST end your reply with an updated machine-readable list that reflects the correction — even if you are only moderately confident. Trust what the user tells you about the location over your earlier guess. ' +
  'Put the token "CANDIDATES:" on its own line (not under a heading, not in a code block), then one location per line as ' +
  '"<geocodable place: street or landmark, suburb, city, region, country> | <latitude>, <longitude> | <one short reason>", best guess first, up to 4. ' +
  'Write the place strings to match what the user told you — use the corrected city/region/country so they geocode there (e.g. if the user says Melbourne, write "…, Melbourne, Victoria, Australia", NOT a same-named place in another country). ' +
  'Only omit the CANDIDATES block if the user asked something that does not change the location at all.';

// --- Session state (for follow-up chat + saved logs) -----------------------
let currentSession = null; // the active conversation, persisted to disk

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function sessionsDir() {
  const d = path.join(app.getPath('userData'), 'sessions');
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {
    /* ignore */
  }
  return d;
}

function safeId(id) {
  return String(id).replace(/[^a-z0-9]/gi, '');
}

function sessionFile(id) {
  return path.join(sessionsDir(), `${safeId(id)}.json`);
}

function indexFile() {
  return path.join(sessionsDir(), 'index.json');
}

function readIndex() {
  try {
    const arr = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeIndex(arr) {
  try {
    fs.writeFileSync(indexFile(), JSON.stringify(arr));
  } catch {
    /* non-fatal */
  }
}

function indexEntry(s) {
  return {
    id: s.id,
    title: s.title || 'Untitled location',
    createdAt: s.createdAt || 0,
    updatedAt: s.updatedAt || s.createdAt || 0,
    turns: Array.isArray(s.chat) ? s.chat.length : 0,
  };
}

function saveSession(s) {
  if (!s || !s.id) return;
  try {
    s.updatedAt = Date.now();
    fs.writeFileSync(sessionFile(s.id), JSON.stringify(s));
    // Update the lightweight index (used by the History list).
    const idx = readIndex().filter((e) => e.id !== s.id);
    idx.unshift(indexEntry(s));
    writeIndex(idx);
  } catch {
    /* non-fatal: history just won't persist */
  }
}

// The History list reads ONLY the small index — never the full session files
// (which hold the base64 images), so listing stays fast with many saved chats.
function listSessions() {
  let idx = readIndex();
  // One-time rebuild if the index is missing but session files exist (e.g. from
  // an older version), reading each file just this once.
  if (!idx.length) {
    let files = [];
    try {
      files = fs.readdirSync(sessionsDir()).filter((f) => f.endsWith('.json') && f !== 'index.json');
    } catch {
      return [];
    }
    for (const f of files) {
      try {
        idx.push(indexEntry(JSON.parse(fs.readFileSync(path.join(sessionsDir(), f), 'utf8'))));
      } catch {
        /* skip a corrupt file */
      }
    }
    if (idx.length) writeIndex(idx);
  }
  return idx.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

function loadSessionFile(id) {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
  } catch {
    return null;
  }
}

function removeSession(id) {
  try {
    fs.unlinkSync(sessionFile(id));
  } catch {
    /* already gone */
  }
  writeIndex(readIndex().filter((e) => e.id !== id));
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 880,
    minHeight: 620,
    backgroundColor: '#0f1220',
    title: 'Geolink',
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

// --- Mid-analysis questions -------------------------------------------------
// The model may ask the user one clarifying question. The main process sends it
// to the renderer and awaits a reply via this handler; the user can answer or
// skip (deny), and a timeout proceeds without an answer so analysis never hangs.
const pendingQuestions = new Map();
let questionSeq = 0;

ipcMain.handle('analyze:answer', (_evt, payload) => {
  const id = payload && payload.id;
  const finish = id != null ? pendingQuestions.get(id) : null;
  if (finish) finish(payload ? payload.answer : null);
});

function askUser(send, question, timeoutMs = 180000) {
  const id = `q${++questionSeq}`;
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      pendingQuestions.delete(id);
      resolve(typeof val === 'string' && val.trim() ? val.trim() : null);
    };
    pendingQuestions.set(id, finish);
    send('analyze:question', { id, question });
    setTimeout(() => finish(null), timeoutMs);
  });
}

// Pull an optional "QUESTION:" the vision step may emit for the user.
function parseQuestion(text) {
  const m = String(text || '').match(/^[ \t]*QUESTION:[ \t]*(.+)$/im);
  if (!m) return '';
  const q = m[1].trim().replace(/^["']|["']$/g, '').trim();
  return /^(none|n\/?a|no)\b/i.test(q) ? '' : q;
}

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

  const toBlock = (im) => ({
    type: 'image_url',
    image_url: { url: `data:${im.mediaType};base64,${im.data}` },
  });

  // Main photos plus any user-highlighted close-up crops (sent after the photos).
  const highlights = Array.isArray(payload && payload.highlights)
    ? payload.highlights.filter((im) => im && im.data && im.mediaType)
    : [];
  const imageBlocks = images.map(toBlock);
  const highlightBlocks = highlights.map(toBlock);
  const allImageBlocks = [...imageBlocks, ...highlightBlocks];
  const photoWord = images.length === 1 ? 'photo' : `${images.length} photos`;

  const highlightNote = highlights.length
    ? `\n\nThe user has highlighted ${highlights.length} region(s) of interest, included as additional close-up image(s) AFTER the main ${photoWord}. Look at these especially closely — they likely contain the most identifying details (text on signs, license plates, logos, house numbers).`
    : '';

  const extra =
    (note && note.trim() ? `\n\nKeep in mind this context from the user: ${note.trim()}` : '') +
    highlightNote;

  // Pipeline: vision observe → vision narrow → [web search] → reason deduce →
  // [verify search] → reason commit. The two web-search steps are skipped when
  // search is disabled in Settings.
  const webEnabled = settings.webSearch !== false;
  const total = webEnabled ? 6 : 4;
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
      { role: 'user', content: [{ type: 'text', text: OBSERVE_PROMPT + extra }, ...allImageBlocks] },
    ];
    const obs1 = await step(`Examining the ${photoWord}`, {
      model, messages: visionMessages, maxTokens: 1400,
    });
    if (!obs1.ok) return { ok: false, error: obs1.error };
    visionMessages.push({ role: 'assistant', content: obs1.text });

    // --- Vision: closer look to narrow down (re-includes the photos) -----
    visionMessages.push({ role: 'user', content: [{ type: 'text', text: VISION_NARROW_PROMPT }, ...allImageBlocks] });
    const obs2 = await step('Looking closer to narrow it down', {
      model, messages: visionMessages, maxTokens: 1200,
    });
    if (!obs2.ok) return { ok: false, error: obs2.error };

    const observations = `${obs1.text}\n\nCloser look — narrowing details:\n${obs2.text}`;

    // --- Web search round 1: clues the vision model read ----------------
    let webContext = '';
    const geoHits = []; // geocoded candidates collected during search (fallback pin)
    if (webEnabled) {
      send('analyze:pass', { pass: ++pass, total, label: 'Searching the web for clues' });
      webContext = await runSearchRound(parseSearches(obs2.text), send, geoHits);
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

    // --- Ask the user the reasoning model's clarifying question ----------
    // (Asked here, after the deduction, so it's well-informed and reliable —
    // the reasoning model follows the instruction better than the vision one.)
    const pendingQ = parseQuestion(deduce.text);
    let answerNote = '';
    if (pendingQ) {
      send('analyze:note', 'The bot has a question for you…');
      const userAnswer = await askUser(send, pendingQ);
      answerNote = userAnswer
        ? `\n\nThe user was asked: "${pendingQ}"\nThe user answered: ${userAnswer}\nWeigh this answer in your final decision.`
        : `\n\nThe user was asked: "${pendingQ}" but chose not to answer — proceed using the visual and web evidence alone.`;
    }

    // --- Web search round 2: verify the deduced candidates --------------
    // A second, targeted search of the model's OWN top candidates — this is what
    // raises certainty: the commit step sees fresh confirmation (or contradiction)
    // for the exact places it's considering. This round ALWAYS searches something:
    // the model's best-so-far place plus its VERIFY queries, falling back to the
    // strongest geocoded hit found so far if it somehow gave us neither.
    let verifyContext = '';
    if (webEnabled) {
      send('analyze:pass', { pass: ++pass, total, label: 'Verifying the location' });
      const verifyQueries = [];
      const bestSoFar = parseBestSoFar(deduce.text);
      if (bestSoFar) verifyQueries.push(bestSoFar);
      for (const q of parseVerify(deduce.text)) {
        if (!verifyQueries.includes(q)) verifyQueries.push(q);
      }
      if (!verifyQueries.length && geoHits.length) {
        const top = geoHits.slice().sort((a, b) => (b.rank || 0) - (a.rank || 0))[0];
        if (top && top.name) verifyQueries.push(top.name);
      }
      verifyContext = await runSearchRound(verifyQueries.slice(0, 5), send, geoHits);
    }

    // --- Reasoning: commit to the most specific location -----------------
    const commitContent =
      (verifyContext
        ? `Fresh web-search results gathered to CONFIRM your candidate locations (use them to verify your answer, correct it if they contradict you, or sharpen the exact place; ignore irrelevant hits):\n\n${verifyContext}\n\n`
        : '') +
      answerNote +
      (answerNote ? '\n\n' : '') +
      FINAL_PROMPT;
    reasonMessages.push({ role: 'user', content: commitContent });
    const final = await step('Final location', {
      model: reasoningModel, messages: reasonMessages, maxTokens: 2000, final: true,
    });
    if (!final.ok) return { ok: false, error: final.error };

    // --- Resolve map pins from the model's CANDIDATES block --------------
    const candidates = await resolveCandidates(final.text, {
      webEnabled,
      geoHits,
      note: (m) => send('analyze:note', m),
      onSearch: (info) => send('analyze:search', info),
    });
    const located = candidates[0] || null;
    if (candidates.length) send('analyze:located', { candidates });

    // --- Persist the session so follow-ups + history work ---------------
    currentSession = {
      id: makeId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      title: (located && (located.place || located.label)) || 'Unknown location',
      images,
      note: note || '',
      reportText: final.text,
      candidates,
      chat: [],
      // Continuation context (text-only, so it stays small):
      messages: reasonMessages.concat([{ role: 'assistant', content: final.text }]),
      reasoningModel,
      webEnabled,
      photoWord,
    };
    saveSession(currentSession);

    return {
      ok: true,
      sessionId: currentSession.id,
      model: `${model} + ${reasoningModel}`,
      passesDone: total,
      located,
      candidates,
      usage: lastUsage
        ? { input_tokens: lastUsage.prompt_tokens, output_tokens: lastUsage.completion_tokens }
        : null,
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// Turn a model's final/follow-up text into geocoded map pins. The model lists
// its best guess first, then alternatives; we GEOCODE each place string for an
// accurate pin (the model's own lat/lng is often a city centroid), keeping its
// lat/lng only as a fallback, and never let an arbitrary web hit override a
// geocoded place. `note` is an optional progress callback.
async function resolveCandidates(finalText, { webEnabled, geoHits = [], note, onSearch } = {}) {
  const tell = typeof note === 'function' ? note : () => {};
  const showSearch = typeof onSearch === 'function' ? onSearch : () => {};
  const parsed = parseCandidates(finalText);
  const candidates = [];

  for (let i = 0; i < parsed.length; i++) {
    const c = parsed[i];
    let lat = c.lat;
    let lng = c.lng;
    let label = c.place;
    let source = 'model';
    let rank = 0;
    if (webEnabled && c.place) {
      if (i === 0) tell(`Pinpointing: ${c.place}…`);
      try {
        const hit = await geocodeBest(c.place);
        if (hit) {
          // PREFER the geocoded coordinates of the place NAME — the model's own
          // lat/lng is frequently hallucinated (e.g. an Australian place tagged
          // with coordinates near Japan). We only keep the model's coords when
          // the geocoded result's name clearly DISAGREES with the place the
          // model wrote (a vague name matching a same-named spot elsewhere, e.g.
          // "Suburbia" → Culiacán, Mexico) AND the model actually gave coords.
          const hasModelPt = Number.isFinite(c.lat) && Number.isFinite(c.lng);
          if (geoConsistent(c.place, hit.name) || !hasModelPt) {
            lat = hit.lat;
            lng = hit.lng;
            label = hit.name;
            source = 'osm';
            rank = hit.rank || 0;
          }
        }
      } catch {
        /* keep the model's own coordinates */
      }
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    // Drop an alternative that ended up implausibly far from the best guess.
    if (candidates.length && haversineKm({ lat, lng }, candidates[0]) > ALT_MAX_KM) continue;
    // Dedup near-identical pins.
    if (candidates.some((p) => haversineKm(p, { lat, lng }) < 1.2)) continue;
    candidates.push({ lat, lng, label, place: c.place, reason: c.reason, source, rank, primary: candidates.length === 0 });
  }

  // Always double-check the best guess with one more search of its own place
  // string, and refine the pin if a more precise hit for the SAME place is near.
  if (webEnabled && candidates.length) {
    const primary = candidates[0];
    if (primary.place) {
      tell(`Double-checking the exact spot for: ${primary.place}…`);
      showSearch({ query: primary.place, pending: true });
      try {
        const r = await searchQuery(primary.place);
        showSearch({
          query: primary.place,
          places: (r.places || []).map((pl) => ({ name: pl.name, lat: pl.lat, lng: pl.lng })),
          web: r.web || [],
        });
        const best = (r.places || []).slice().sort((a, b) => (b.rank || 0) - (a.rank || 0))[0];
        if (best && (best.rank || 0) > (primary.rank || 0) && haversineKm(best, primary) < 40) {
          primary.lat = best.lat;
          primary.lng = best.lng;
          primary.label = best.name;
          primary.source = 'osm';
          primary.rank = best.rank || 0;
        }
      } catch {
        // Resolve the card even if the lookup failed, so it doesn't spin forever.
        showSearch({ query: primary.place, places: [], web: [] });
      }
    }
  }

  // Last-resort fallbacks if the CANDIDATES block was unusable.
  if (!candidates.length && webEnabled && geoHits.length) {
    const best = geoHits.slice().sort((a, b) => (b.rank || 0) - (a.rank || 0))[0];
    if (best) {
      candidates.push({ lat: best.lat, lng: best.lng, label: best.name, place: best.name, reason: 'Best match found while searching the web', source: 'osm', rank: best.rank || 0, primary: true });
    }
  }
  if (!candidates.length) {
    const placeStr = parsePlace(finalText);
    const modelGeo = parseGeoLine(finalText);
    let lat;
    let lng;
    let label = placeStr || 'Model estimate';
    let source = 'model';
    let rank = 0;
    if (webEnabled && placeStr) {
      try {
        const hit = await geocodeBest(placeStr);
        if (hit) {
          lat = hit.lat;
          lng = hit.lng;
          label = hit.name;
          source = 'osm';
          rank = hit.rank || 0;
        }
      } catch {
        /* fall through */
      }
    }
    if ((!Number.isFinite(lat) || !Number.isFinite(lng)) && modelGeo) {
      lat = modelGeo.lat;
      lng = modelGeo.lng;
    }
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      candidates.push({ lat, lng, label, place: placeStr, reason: '', source, rank, primary: true });
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// IPC: follow-up chat — continue the conversation to refine the location
// ---------------------------------------------------------------------------
ipcMain.handle('chat:followup', async (evt, payload) => {
  const message = payload && typeof payload.message === 'string' ? payload.message.trim() : '';
  if (!currentSession) return { ok: false, error: 'Locate a photo first, then you can ask follow-up questions.' };
  if (!message) return { ok: false, error: 'Type a message first.' };

  const settings = readSettings();
  const baseUrl = settings.baseUrl || DEFAULT_BASE_URL;
  const local = isLocalUrl(baseUrl);
  const endpoint = chatEndpoint(baseUrl);
  const apiKey = settings.apiKey ? String(settings.apiKey).trim() : '';
  if (!apiKey && !local) return { ok: false, error: 'No token set. Open Settings and paste your Hugging Face token, or use local Ollama.' };

  const sender = evt.sender;
  const send = (ch, msg) => {
    if (!sender.isDestroyed()) sender.send(ch, msg);
  };

  const sess = currentSession;
  sess.chat.push({ role: 'user', text: message });
  sess.messages.push({ role: 'user', content: `${message}\n\n${FOLLOWUP_PROMPT}` });

  const r = await callWithRetry({
    url: endpoint,
    apiKey,
    model: sess.reasoningModel,
    messages: sess.messages,
    maxTokens: 1600,
    onDelta: (d) => send('chat:delta', d),
    onRetry: (info) => send('chat:note', `Rate-limited, waiting ${info.waitSec}s (retry ${info.attempt})…`),
  });
  if (!r.ok) {
    // Roll back the unanswered turn so the user can retry cleanly.
    sess.messages.pop();
    sess.chat.pop();
    return { ok: false, error: r.error };
  }
  sess.messages.push({ role: 'assistant', content: r.text });
  sess.chat.push({ role: 'assistant', text: r.text });

  // Update pins only if the model emitted a fresh CANDIDATES block.
  let candidates = null;
  if (/^[ \t]*CANDIDATES:/im.test(r.text) || /map candidates/i.test(r.text)) {
    const resolved = await resolveCandidates(r.text, { webEnabled: sess.webEnabled, geoHits: [] });
    if (resolved.length) {
      candidates = resolved;
      sess.candidates = resolved;
      if (resolved[0]) sess.title = resolved[0].place || resolved[0].label || sess.title;
      send('chat:located', { candidates });
    }
  }
  saveSession(sess);
  return { ok: true, text: r.text, candidates };
});

// ---------------------------------------------------------------------------
// IPC: sessions / history + reset
// ---------------------------------------------------------------------------
ipcMain.handle('session:reset', () => {
  // Resolve any pending question as "skipped" and forget the active chat so the
  // next run starts completely fresh (frees the held conversation + images).
  for (const finish of pendingQuestions.values()) finish(null);
  pendingQuestions.clear();
  currentSession = null;
  return { ok: true };
});

ipcMain.handle('sessions:list', () => listSessions());

ipcMain.handle('sessions:load', (_evt, id) => {
  const s = loadSessionFile(id);
  if (s) currentSession = s; // make it active so the user can keep chatting
  return s;
});

ipcMain.handle('sessions:delete', (_evt, id) => {
  removeSession(id);
  if (currentSession && currentSession.id === id) currentSession = null;
  return { ok: true };
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Does a geocoder's result name agree with the place string the model wrote?
// Used to decide whether to trust a geocode over the model's own (often
// hallucinated) coordinates. We weight the TAIL of the place string — the last
// couple of comma segments, i.e. the city/region/country — because that's what
// actually determines the location. So a same-named business in another country
// (e.g. "Forest Hill … Melbourne, Australia" geocoding to a Forest Hill in
// Kitchener, Canada) is rejected even though the business-name tokens matched.
function geoConsistent(placeStr, geoName) {
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // strip combining diacritics
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  const name = norm(geoName);
  if (!name) return false;
  const segs = String(placeStr || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const tailTokens = [...new Set(norm(segs.slice(-2).join(' ')).split(' ').filter((t) => t.length >= 4))];
  if (tailTokens.length) {
    // The geocoded result must mention the city/region/country the model wrote.
    return tailTokens.some((t) => name.includes(t));
  }
  // No city/country given — fall back to any significant shared token.
  const tokens = [...new Set(norm(placeStr).split(' ').filter((t) => t.length >= 4))];
  if (!tokens.length) return true;
  return tokens.some((t) => name.includes(t));
}

// Great-circle distance in km (used to keep search-hit pins near the deduced area).
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
const SEARCH_UA = 'Geolink/1.0 (personal desktop geolocation app)';

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

// Pull a labelled query list ("SEARCHES:" / "VERIFY:") the model is asked to
// emit — the header line plus the consecutive query lines after it.
function parseQueryList(text, keyword, max) {
  const re = new RegExp(`^[ \\t]*${keyword}:[ \\t]*(.*)$`, 'im');
  const m = String(text || '').match(re);
  if (!m) return [];
  const start = text.indexOf(m[0]) + m[0].length;
  const lines = ((m[1] || '') + '\n' + text.slice(start)).split('\n');
  const out = [];
  let started = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (started) break; // blank line ends the consecutive query block
      continue;
    }
    if (/^none\b/i.test(line)) break;
    // Stop if we've reached another labelled section or a heading.
    if (started && /^(SEARCHES|VERIFY|CANDIDATES|QUESTION|#)/i.test(line)) break;
    if (line.startsWith('```')) continue;
    const q = line.replace(/^[-*•\d.)\s]+/, '').replace(/^["']|["']$/g, '').trim();
    if (q) {
      out.push(q);
      started = true;
    }
    if (out.length >= (max || 5)) break;
  }
  return out;
}

// The vision step's clue searches, and the reasoning step's verification searches.
function parseSearches(text) {
  return parseQueryList(text, 'SEARCHES', 5);
}
function parseVerify(text) {
  return parseQueryList(text, 'VERIFY', 4);
}

// The reasoning step's single best-so-far place (a geocodable string we always
// verify, so a search runs even if the model gives no VERIFY queries).
function parseBestSoFar(text) {
  const m = String(text || '').match(/^[ \t]*BESTSOFAR:[ \t]*(.+)$/im);
  if (!m) return '';
  const v = m[1].trim().replace(/^["']|["']$/g, '').trim();
  return /^(none|n\/?a|unknown)\b/i.test(v) ? '' : v;
}

// Run a round of web searches, streaming each query + its results to the UI and
// collecting geocoded hits. Returns a text block of the results for the model.
async function runSearchRound(queries, send, geoHits) {
  if (!queries || !queries.length) {
    send('analyze:search', { empty: true });
    return '';
  }
  const blocks = [];
  for (const q of queries) {
    // Show the query immediately (spinner), then replace with its results.
    send('analyze:search', { query: q, pending: true });
    let r;
    try {
      r = await searchQuery(q);
    } catch {
      r = { query: q, places: [], web: [] };
    }
    for (const pl of r.places) geoHits.push({ ...pl, query: q });
    send('analyze:search', {
      query: q,
      places: r.places.map((pl) => ({ name: pl.name, lat: pl.lat, lng: pl.lng })),
      web: r.web,
    });
    let b = `Query: "${q}"\n`;
    for (const pl of r.places) {
      b += `- Map match: ${pl.name} (${pl.lat.toFixed(4)}, ${pl.lng.toFixed(4)})\n`;
    }
    for (const w of r.web) b += `- ${w}\n`;
    if (!r.places.length && !r.web.length) b += '- (no results)\n';
    b += '\n';
    blocks.push(b);
    await sleep(600); // be polite to the free endpoints
  }
  return blocks.join('');
}

// Two free geocoders for better coverage of streets & businesses. Each result
// carries a `rank` (higher = more specific: house > street > suburb > city >
// country) so we can prefer precise matches over centroids.
async function nominatimGeocode(q) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3&q=${encodeURIComponent(q)}`;
  const j = await fetchJsonSafe(url, { 'User-Agent': SEARCH_UA, 'Accept-Language': 'en' });
  if (!Array.isArray(j)) return [];
  return j
    .map((p) => ({
      name: p.display_name,
      lat: parseFloat(p.lat),
      lng: parseFloat(p.lon),
      rank: Number(p.place_rank) || 14,
      source: 'osm',
    }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

const PHOTON_RANK = { house: 30, building: 28, street: 26, locality: 22, district: 20, city: 16, county: 12, state: 8, country: 4 };

async function photonGeocode(q) {
  const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=3&lang=en`;
  const j = await fetchJsonSafe(url, { 'User-Agent': SEARCH_UA });
  const feats = (j && j.features) || [];
  return feats
    .map((f) => {
      const c = (f.geometry && f.geometry.coordinates) || [];
      const pr = f.properties || {};
      const name = [pr.name, pr.street && `${pr.housenumber || ''} ${pr.street}`.trim(), pr.city, pr.state, pr.country]
        .filter(Boolean)
        .join(', ');
      return {
        name: name || pr.name || '',
        lat: Number(c[1]),
        lng: Number(c[0]),
        rank: (pr.housenumber ? 30 : PHOTON_RANK[pr.type]) || 14,
        source: 'photon',
      };
    })
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.name);
}

// Merge both geocoders, most-specific first.
async function geocode(q) {
  const [a, b] = await Promise.all([nominatimGeocode(q), photonGeocode(q)]);
  return [...a, ...b].sort((x, y) => y.rank - x.rank);
}

async function wikiSearch(q) {
  const url = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=2&origin=*`;
  const j = await fetchJsonSafe(url);
  const arr = (j && j.query && j.query.search) || [];
  return arr.map((s) => `${s.title}: ${stripHtml(s.snippet)}`);
}

async function ddgInstant(q) {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&no_redirect=1&t=geolink`;
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
  return { query: q, places: places.slice(0, 2), web: [...web, ...wiki, ...ia].slice(0, 5) };
}

// Pull the "PLACE:" line the final step is asked to emit (geocodable string).
function parsePlace(text) {
  const m = String(text || '').match(/^[ \t]*PLACE:[ \t]*(.+)$/im);
  if (!m) return '';
  const v = m[1].trim();
  return /^none$/i.test(v) ? '' : v;
}

// Pull the "GEO: lat, lng" fallback line.
function parseGeoLine(text) {
  const m = String(text || '').match(/^[ \t]*GEO:[ \t]*(-?\d{1,3}(?:\.\d+)?)[ \t]*,[ \t]*(-?\d{1,3}(?:\.\d+)?)/im);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
  return null;
}

// Parse a "lat, lng" token into {lat,lng}, rejecting out-of-range or 0,0.
function parseLatLng(s) {
  const m = String(s || '').match(/(-?\d{1,3}(?:\.\d+)?)[ \t]*,[ \t]*(-?\d{1,3}(?:\.\d+)?)/);
  if (!m) return null;
  const lat = parseFloat(m[1]);
  const lng = parseFloat(m[2]);
  if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0)) {
    return { lat, lng };
  }
  return null;
}

// Parse the "CANDIDATES:" block the final step emits — one location per line in
// "<geocodable place> | <lat>, <lng> | <short reason>" format. Best-first, up to
// 4, dropping the "none" placeholder and stray code-fence lines. Returns
// [{ place, lat, lng, reason }].
function parseCandidates(text) {
  const str = String(text || '');
  // Anchor on the "CANDIDATES:" token, or fall back to a "machine-readable /
  // map candidates" heading the model sometimes emits instead.
  let header = str.match(/^[ \t]*CANDIDATES:[ \t]*(.*)$/im);
  if (!header) header = str.match(/^[ \t]*#{0,6}[ \t]*(?:machine-readable[^\n]*|[^\n]*map candidates[^\n]*)$/im);
  if (!header) return [];
  const start = str.indexOf(header[0]) + header[0].length;
  // The header line may itself carry the first candidate (after "CANDIDATES:").
  const body = (header[1] ? header[1] + '\n' : '') + str.slice(start);
  const out = [];
  for (const raw of body.split('\n')) {
    let line = raw.trim();
    if (!line) continue;
    if (line.startsWith('```')) continue; // tolerate a stray code fence
    // Strip a leading bullet/number marker.
    line = line.replace(/^(?:[-*•]|\d+[.)])\s+/, '');
    if (!line.includes('|')) {
      if (out.length) break; // left the block
      continue;
    }
    const parts = line.split('|').map((p) => p.trim());
    const place = parts[0] || '';
    if (!place || /^none$/i.test(place)) continue;
    const coords = parts[1] ? parseLatLng(parts[1]) : null;
    out.push({
      place,
      lat: coords ? coords.lat : null,
      lng: coords ? coords.lng : null,
      reason: parts.slice(2).join(' | ').trim(),
    });
    if (out.length >= 4) break;
  }
  return out;
}

// Geocode the final place string with OpenStreetMap. If the most specific form
// isn't found, drop the leading (most specific) comma segment and retry, so we
// still land at suburb/city level instead of failing.
async function geocodeBest(place) {
  let q = String(place || '').trim();
  for (let i = 0; i < 3 && q; i++) {
    const hits = await geocode(q); // sorted most-specific first
    if (hits.length) {
      const h = hits[0];
      return { lat: h.lat, lng: h.lng, name: h.name, rank: h.rank, query: q };
    }
    const parts = q.split(',');
    if (parts.length <= 1) break;
    q = parts.slice(1).join(',').trim();
    await sleep(400);
  }
  return null;
}
