'use strict';

// --- DOM refs ---------------------------------------------------------------
const dropzone = document.getElementById('dropzone');
const dropzoneEmpty = document.getElementById('dropzone-empty');
const preview = document.getElementById('preview');
const note = document.getElementById('note');
const analyzeBtn = document.getElementById('analyze-btn');
const clearBtn = document.getElementById('clear-btn');
const leftStatus = document.getElementById('left-status');

const resultEl = document.getElementById('result');
const resultEmpty = document.getElementById('result-empty');
const usageEl = document.getElementById('usage');
const modelBadge = document.getElementById('model-badge');

const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const apiKeyInput = document.getElementById('api-key');
const modelSelect = document.getElementById('model-select');
const settingsSave = document.getElementById('settings-save');
const settingsCancel = document.getElementById('settings-cancel');
const modelReload = document.getElementById('model-reload');
const modelStatus = document.getElementById('model-status');

const mapWrap = document.getElementById('map-wrap');
const mapLabel = document.getElementById('map-label');
const mapLink = document.getElementById('map-link');

// --- State ------------------------------------------------------------------
let currentImage = null; // { mediaType, data, name }
let busy = false;

// --- Map (Leaflet, bundled locally) -----------------------------------------
let map = null;
let marker = null;

// Tell Leaflet where its bundled marker images live.
if (window.L) {
  L.Icon.Default.imagePath = 'vendor/leaflet/images/';
}

function ensureMap() {
  if (map) return map;
  map = L.map('map', { zoomControl: true, attributionControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors',
  }).addTo(map);
  return map;
}

function hideMap() {
  mapWrap.classList.add('hidden');
}

function showLocation(lat, lng, labelText) {
  mapWrap.classList.remove('hidden');
  const m = ensureMap();
  // The container was hidden when created, so Leaflet must recompute its size.
  setTimeout(() => m.invalidateSize(), 0);

  const zoom = 5;
  m.setView([lat, lng], zoom);
  if (marker) {
    marker.setLatLng([lat, lng]);
  } else {
    marker = L.marker([lat, lng]).addTo(m);
  }
  marker.bindPopup(labelText || 'Best guess').openPopup();

  mapLabel.textContent = `📍 ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  const q = `${lat},${lng}`;
  mapLink.dataset.url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

mapLink.addEventListener('click', (e) => {
  e.preventDefault();
  const url = mapLink.dataset.url;
  if (url) window.api.openExternal(url);
});

// Parse the machine-readable "GEO: lat, lng" line the model is asked to emit,
// with a light fallback to the first decimal lat/lng pair in the text.
function parseCoords(text) {
  const geo = text.match(/^\s*GEO:\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/im);
  if (geo) {
    return validatePair(parseFloat(geo[1]), parseFloat(geo[2]));
  }
  if (/^\s*GEO:\s*none\s*$/im.test(text)) return null;

  // Fallback: a "lat, lng" decimal pair anywhere in the text.
  const pair = text.match(/(-?\d{1,2}(?:\.\d+)?)\s*[,/]\s*(-?\d{1,3}(?:\.\d+)?)/);
  if (pair) return validatePair(parseFloat(pair[1]), parseFloat(pair[2]));
  return null;
}

function validatePair(lat, lng) {
  if (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  ) {
    return { lat, lng };
  }
  return null;
}

// Remove the GEO line so it isn't shown in the rendered analysis.
function stripGeoLine(text) {
  return text.replace(/^\s*GEO:.*$/gim, '').trimEnd();
}

// Pull the "Best guess" line for the map popup, if present.
function bestGuessLine(text) {
  const m = text.match(/##\s*Best guess\s*\n+([^\n]+)/i);
  return m ? m[1].replace(/\*\*/g, '').trim() : '';
}

// --- Settings ---------------------------------------------------------------
function shortModelName(id) {
  // "google/gemini-2.0-flash-exp:free" -> "gemini-2.0-flash-exp"
  return String(id).split('/').pop().replace(/:free$/, '');
}

async function refreshSettingsBadge() {
  const s = await window.api.getSettings();
  modelBadge.textContent = s.hasApiKey ? shortModelName(s.model) : 'no API key';
  modelBadge.title = s.model;
  modelBadge.style.color = s.hasApiKey ? '' : 'var(--warn)';
  modelSelect.value = s.model;
  return s;
}

async function openSettings() {
  const s = await window.api.getSettings();
  apiKeyInput.value = '';
  apiKeyInput.placeholder = s.hasApiKey
    ? '•••••••• saved — leave blank to keep it'
    : 'sk-or-v1-...';
  settingsModal.classList.remove('hidden');
  apiKeyInput.focus();
  loadModels(); // populate the dropdown with the available Gemma vision models
}

// Pull the live list of image-capable models from OpenRouter and fill the
// dropdown. Keeps the user's saved model selected even if it isn't in the list.
function fillSelect(select, models, selectedId) {
  select.innerHTML = '';
  let list = models;
  if (selectedId && !list.some((m) => m.id === selectedId)) {
    list = [{ id: selectedId, name: `${selectedId} (saved)`, free: false }, ...list];
  }
  for (const m of list) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.free ? `${m.name} — free` : m.name;
    select.appendChild(opt);
  }
  select.value =
    selectedId && list.some((m) => m.id === selectedId) ? selectedId : list[0].id;
}

async function loadModels() {
  modelReload.disabled = true;
  modelStatus.style.color = '';
  modelStatus.textContent = 'Loading models from OpenRouter…';
  modelSelect.innerHTML = '';

  const [res, settings] = await Promise.all([
    window.api.listModels(),
    window.api.getSettings(),
  ]);
  modelReload.disabled = false;

  if (!res.ok || !res.models || res.models.length === 0) {
    const opt = document.createElement('option');
    opt.value = settings.model || '';
    opt.textContent = settings.model ? `${settings.model} (list unavailable)` : 'No models loaded';
    modelSelect.appendChild(opt);
    modelStatus.style.color = 'var(--warn)';
    modelStatus.textContent = res.ok
      ? 'Could not find the Gemma models right now. Check your connection and retry (↻).'
      : `Could not load models: ${res.error}`;
    return;
  }

  fillSelect(modelSelect, res.models, settings.model);
  modelStatus.style.color = '';
  modelStatus.textContent = `${res.models.length} model${res.models.length === 1 ? '' : 's'} available`;
}

modelReload.addEventListener('click', loadModels);

function closeSettings() {
  settingsModal.classList.add('hidden');
}

settingsBtn.addEventListener('click', openSettings);
settingsCancel.addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});

settingsSave.addEventListener('click', async () => {
  await window.api.saveSettings({
    apiKey: apiKeyInput.value, // blank is ignored by main; keeps existing key
    model: modelSelect.value,
  });
  closeSettings();
  await refreshSettingsBadge();
});

// --- Image handling ---------------------------------------------------------
function setImage(img) {
  currentImage = img;
  preview.src = `data:${img.mediaType};base64,${img.data}`;
  preview.classList.remove('hidden');
  dropzoneEmpty.classList.add('hidden');
  leftStatus.textContent = img.name ? `Loaded: ${img.name}` : 'Image ready';
  updateButtons();
}

function clearImage() {
  currentImage = null;
  preview.src = '';
  preview.classList.add('hidden');
  dropzoneEmpty.classList.remove('hidden');
  leftStatus.textContent = '';
  updateButtons();
}

function updateButtons() {
  analyzeBtn.disabled = busy || !currentImage;
  clearBtn.disabled = busy || !currentImage;
  analyzeBtn.textContent = busy ? 'Analyzing…' : 'Locate photo';
}

const SUPPORTED = {
  'image/jpeg': true,
  'image/png': true,
  'image/webp': true,
  'image/gif': true,
};

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    if (!SUPPORTED[file.type]) {
      reject(new Error('Unsupported image type. Use JPEG, PNG, WebP, or GIF.'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1];
      resolve({ name: file.name, mediaType: file.type, data: base64 });
    };
    reader.onerror = () => reject(new Error('Could not read the image file.'));
    reader.readAsDataURL(file);
  });
}

async function handleFile(file) {
  try {
    setImage(await fileToImage(file));
  } catch (err) {
    leftStatus.textContent = err.message;
    leftStatus.style.color = 'var(--warn)';
  }
}

// Click to pick via native dialog
dropzone.addEventListener('click', async () => {
  if (busy) return;
  const img = await window.api.pickImage();
  if (img) setImage(img);
});

// Drag & drop
['dragenter', 'dragover'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  })
);
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) handleFile(file);
});

// Paste from clipboard
window.addEventListener('paste', (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) handleFile(file);
      break;
    }
  }
});

clearBtn.addEventListener('click', () => {
  if (busy) return;
  clearImage();
  resultEl.classList.add('hidden');
  resultEl.innerHTML = '';
  resultEmpty.classList.remove('hidden');
  usageEl.classList.add('hidden');
  hideMap();
});

// --- Analyze ----------------------------------------------------------------
analyzeBtn.addEventListener('click', runAnalysis);

async function runAnalysis() {
  if (!currentImage || busy) return;

  const settings = await window.api.getSettings();
  if (!settings.hasApiKey) {
    openSettings();
    return;
  }

  busy = true;
  updateButtons();
  leftStatus.style.color = '';
  leftStatus.textContent = 'Starting…';

  resultEmpty.classList.add('hidden');
  usageEl.classList.add('hidden');
  hideMap();
  resultEl.classList.remove('hidden');
  resultEl.classList.add('cursor');
  resultEl.innerHTML = '';

  // `raw` accumulates the CURRENT question's answer. Each new question resets it.
  let raw = '';
  let curLabel = ''; // heading for the question being answered now
  let curFinal = false; // is this the final synthesis step?

  function render() {
    const heading = curLabel && !curFinal ? `## ${curLabel}\n\n` : '';
    resultEl.innerHTML = renderMarkdown(heading + stripGeoLine(raw));
    resultEl.scrollTop = resultEl.scrollHeight;
  }

  const offDelta = window.api.onDelta((delta) => {
    raw += delta;
    render();
  });

  const offPass = window.api.onPass((info) => {
    if (info.retry) {
      leftStatus.style.color = 'var(--warn)';
      leftStatus.textContent = `Question ${info.pass}/${info.total}: rate-limited, retry ${info.retry}…`;
      return;
    }
    // A new question is beginning — reset the answer area.
    raw = '';
    curLabel = info.label || '';
    curFinal = Boolean(info.final);
    resultEl.innerHTML = '';
    leftStatus.style.color = '';
    leftStatus.textContent = info.final
      ? `Synthesising final location (${info.pass}/${info.total})…`
      : `Question ${info.pass}/${info.total}: ${info.label}…`;
  });

  const offNote = window.api.onNote((text) => {
    leftStatus.style.color = '';
    leftStatus.textContent = text;
  });

  const res = await window.api.analyze({
    mediaType: currentImage.mediaType,
    data: currentImage.data,
    note: note.value,
  });

  offDelta();
  offPass();
  offNote();
  resultEl.classList.remove('cursor');
  busy = false;
  updateButtons();

  if (!res.ok) {
    leftStatus.style.color = 'var(--warn)';
    leftStatus.textContent = res.error;
    if (!raw) {
      resultEl.classList.add('hidden');
      resultEmpty.classList.remove('hidden');
    }
    return;
  }

  // Final synthesis: render the structured answer and map it.
  curFinal = true;
  resultEl.innerHTML = renderMarkdown(stripGeoLine(raw));
  const coords = parseCoords(raw);
  if (coords) {
    showLocation(coords.lat, coords.lng, bestGuessLine(raw));
    leftStatus.style.color = '';
    leftStatus.textContent = 'Done.';
  } else {
    hideMap();
    leftStatus.textContent = 'Done — no mappable coordinates were returned.';
  }

  if (res.usage) {
    usageEl.textContent = `${shortModelName(res.model)} · final step ${res.usage.input_tokens} in / ${res.usage.output_tokens} out tokens`;
    usageEl.classList.remove('hidden');
  }
}

// --- Tiny Markdown renderer -------------------------------------------------
// Handles the subset the prompt emits: ## headings, **bold**, `code`,
// and - bulleted lists. Escapes HTML first so model output can't inject markup.
function renderMarkdown(md) {
  const escaped = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const lines = escaped.split('\n');
  let html = '';
  let inList = false;

  const inline = (s) =>
    s
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

  const closeList = () => {
    if (inList) {
      html += '</ul>';
      inList = false;
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }
    if (trimmed.startsWith('## ')) {
      closeList();
      html += `<h2>${inline(trimmed.slice(3))}</h2>`;
    } else if (trimmed.startsWith('# ')) {
      closeList();
      html += `<h2>${inline(trimmed.slice(2))}</h2>`;
    } else if (/^[-*]\s+/.test(trimmed)) {
      if (!inList) {
        html += '<ul>';
        inList = true;
      }
      html += `<li>${inline(trimmed.replace(/^[-*]\s+/, ''))}</li>`;
    } else {
      closeList();
      html += `<p>${inline(trimmed)}</p>`;
    }
  }
  closeList();
  return html;
}

// --- Init -------------------------------------------------------------------
(async function init() {
  const s = await refreshSettingsBadge();
  if (!s.hasApiKey) {
    leftStatus.style.color = 'var(--warn)';
    leftStatus.textContent = 'Add your OpenRouter API key in Settings to begin.';
  }
})();
