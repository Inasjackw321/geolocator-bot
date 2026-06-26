'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

// The SDK ships both CJS and ESM entry points. Normalize to the class
// regardless of which interop shape `require` hands back.
const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.default || sdk;

// ---------------------------------------------------------------------------
// Local settings (API key + model). Stored in the OS-standard userData dir.
// This is a plaintext file readable by the local user — fine for a personal
// desktop tool, but it is not a secret store. See README for details.
// ---------------------------------------------------------------------------
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

const DEFAULT_MODEL = 'claude-opus-4-8';

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
// IPC: analyze — streams the model's response back to the renderer
// ---------------------------------------------------------------------------
ipcMain.handle('analyze:start', async (evt, payload) => {
  const { mediaType, data, note } = payload || {};
  const settings = readSettings();

  if (!settings.apiKey) {
    return { ok: false, error: 'No API key set. Open Settings and paste your Anthropic API key.' };
  }
  if (!data || !mediaType) {
    return { ok: false, error: 'No image provided.' };
  }

  const client = new Anthropic({ apiKey: settings.apiKey });
  const model = settings.model || DEFAULT_MODEL;
  const sender = evt.sender;

  const userContent = [
    { type: 'image', source: { type: 'base64', media_type: mediaType, data } },
    {
      type: 'text',
      text: note && note.trim()
        ? `Analyze this photo and determine where it was taken.\n\nAdditional context from me: ${note.trim()}`
        : 'Analyze this photo and determine where it was taken.',
    },
  ];

  try {
    const stream = client.messages.stream({
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    });

    stream.on('text', (delta) => {
      if (!sender.isDestroyed()) sender.send('analyze:delta', delta);
    });

    const final = await stream.finalMessage();
    return {
      ok: true,
      model: final.model,
      usage: final.usage,
      stopReason: final.stop_reason,
    };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
});

function describeError(err) {
  if (!err) return 'Unknown error.';
  // Anthropic SDK errors expose status + message.
  if (err.status === 401) return 'Authentication failed — check that your API key is correct.';
  if (err.status === 403) return 'Permission denied — your key may not have access to this model.';
  if (err.status === 429) return 'Rate limited — wait a moment and try again.';
  if (err.status >= 500) return `Anthropic service error (${err.status}). Try again shortly.`;
  return err.message || String(err);
}
