'use strict';

// --- DOM refs ---------------------------------------------------------------
const dropzone = document.getElementById('dropzone');
const dropzoneEmpty = document.getElementById('dropzone-empty');
const thumbs = document.getElementById('thumbs');
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
const modelInput = document.getElementById('model-select');
const settingsSave = document.getElementById('settings-save');
const settingsCancel = document.getElementById('settings-cancel');
const reasoningInput = document.getElementById('reasoning-input');
const baseUrlInput = document.getElementById('base-url');
const presetHf = document.getElementById('preset-hf');
const presetOllama = document.getElementById('preset-ollama');

const mapWrap = document.getElementById('map-wrap');
const mapLabel = document.getElementById('map-label');
const mapLink = document.getElementById('map-link');

// --- State ------------------------------------------------------------------
let images = []; // [{ mediaType, data, name }]
const MAX_IMAGES = 8;
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

// Reasoning models (e.g. GLM-5.2) may emit a <think>...</think> chain of
// thought. Hide it from the displayed answer, including a not-yet-closed block
// that's still streaming.
function stripThink(text) {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const open = t.search(/<think>/i);
  if (open !== -1) t = t.slice(0, open);
  return t;
}

function cleanForDisplay(text) {
  return stripThink(stripGeoLine(text));
}

// Pull the "Best guess" line for the map popup, if present.
function bestGuessLine(text) {
  const m = text.match(/##\s*Best guess\s*\n+([^\n]+)/i);
  return m ? m[1].replace(/\*\*/g, '').trim() : '';
}

// --- Settings ---------------------------------------------------------------
function shortModelName(id) {
  // "zai-org/GLM-4.5V" -> "GLM-4.5V"
  return String(id).split('/').pop().replace(/:.*$/, '');
}

async function refreshSettingsBadge() {
  const s = await window.api.getSettings();
  // A configured endpoint is "ready" if it's local (no token needed) or has a token.
  const ready = s.local || s.hasApiKey;
  const label = s.local ? `${shortModelName(s.model)} · local` : shortModelName(s.model);
  modelBadge.textContent = ready ? label : 'no token';
  modelBadge.title = `${s.model}  @  ${s.baseUrl}`;
  modelBadge.style.color = ready ? '' : 'var(--warn)';
  return s;
}

async function openSettings() {
  const s = await window.api.getSettings();
  apiKeyInput.value = '';
  apiKeyInput.placeholder = s.hasApiKey
    ? '•••••••• saved — leave blank to keep it'
    : s.local
      ? '(not needed for local Ollama)'
      : 'hf_...';
  baseUrlInput.value = s.baseUrl || 'https://router.huggingface.co/v1';
  modelInput.value = s.model || 'zai-org/GLM-4.5V';
  reasoningInput.value = s.reasoningModel || 'zai-org/GLM-5.2';
  settingsModal.classList.remove('hidden');
  apiKeyInput.focus();
}

function closeSettings() {
  settingsModal.classList.add('hidden');
}

settingsBtn.addEventListener('click', openSettings);
settingsCancel.addEventListener('click', closeSettings);
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});

// Preset buttons fill the endpoint + sensible model defaults for each provider.
presetHf.addEventListener('click', () => {
  baseUrlInput.value = 'https://router.huggingface.co/v1';
  if (!modelInput.value || /localhost|llama|llava|qwen|gemma|minicpm/i.test(modelInput.value)) {
    modelInput.value = 'zai-org/GLM-4.5V';
    reasoningInput.value = 'zai-org/GLM-5.2';
  }
});
presetOllama.addEventListener('click', () => {
  baseUrlInput.value = 'http://localhost:11434/v1';
  if (!modelInput.value || /\//.test(modelInput.value)) {
    modelInput.value = 'llama3.2-vision';
    reasoningInput.value = 'qwen2.5';
  }
});

settingsSave.addEventListener('click', async () => {
  await window.api.saveSettings({
    apiKey: apiKeyInput.value, // blank is ignored by main; keeps existing key
    baseUrl: baseUrlInput.value,
    model: modelInput.value,
    reasoningModel: reasoningInput.value,
  });
  closeSettings();
  await refreshSettingsBadge();
});

// --- Image handling ---------------------------------------------------------
function renderThumbs() {
  thumbs.innerHTML = '';
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const cell = document.createElement('div');
    cell.className = 'thumb';

    const el = document.createElement('img');
    el.src = `data:${img.mediaType};base64,${img.data}`;
    el.alt = img.name || `photo ${i + 1}`;
    cell.appendChild(el);

    const rm = document.createElement('button');
    rm.className = 'thumb-remove';
    rm.type = 'button';
    rm.textContent = '×';
    rm.title = 'Remove';
    rm.dataset.index = String(i);
    cell.appendChild(rm);

    thumbs.appendChild(cell);
  }

  const has = images.length > 0;
  thumbs.classList.toggle('hidden', !has);
  dropzoneEmpty.classList.toggle('hidden', has);
  if (has) {
    leftStatus.style.color = '';
    leftStatus.textContent = `${images.length} photo${images.length === 1 ? '' : 's'} ready · click to add more`;
  } else {
    leftStatus.textContent = '';
  }
  updateButtons();
}

function clearImages() {
  images = [];
  renderThumbs();
}

function updateButtons() {
  analyzeBtn.disabled = busy || images.length === 0;
  clearBtn.disabled = busy || images.length === 0;
  analyzeBtn.textContent = busy ? 'Analyzing…' : 'Locate';
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

// Add one or more images (from files or the native picker), respecting the cap.
function addImages(newOnes) {
  let added = 0;
  let capped = false;
  for (const img of newOnes) {
    if (images.length >= MAX_IMAGES) {
      capped = true;
      break;
    }
    images.push(img);
    added += 1;
  }
  renderThumbs();
  if (capped) {
    leftStatus.style.color = 'var(--warn)';
    leftStatus.textContent = `Added ${added}. Limit is ${MAX_IMAGES} photos.`;
  }
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f && f.type.startsWith('image/'));
  if (files.length === 0) return;
  const results = [];
  for (const f of files) {
    try {
      results.push(await fileToImage(f));
    } catch (err) {
      leftStatus.style.color = 'var(--warn)';
      leftStatus.textContent = err.message;
    }
  }
  if (results.length) addImages(results);
}

// Click the dropzone to add via native dialog; click a thumbnail × to remove.
dropzone.addEventListener('click', async (e) => {
  if (busy) return;
  const rm = e.target.closest('.thumb-remove');
  if (rm) {
    e.stopPropagation();
    const idx = parseInt(rm.dataset.index, 10);
    if (Number.isInteger(idx)) {
      images.splice(idx, 1);
      renderThumbs();
    }
    return;
  }
  const picked = await window.api.pickImage(); // array
  if (Array.isArray(picked) && picked.length) addImages(picked);
});

// Drag & drop (multiple)
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
  if (busy) return;
  addFiles(e.dataTransfer.files);
});

// Paste from clipboard (one or more images)
window.addEventListener('paste', (e) => {
  if (busy) return;
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  const files = [];
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length) addFiles(files);
});

clearBtn.addEventListener('click', () => {
  if (busy) return;
  clearImages();
  resultEl.classList.add('hidden');
  resultEl.innerHTML = '';
  resultEmpty.classList.remove('hidden');
  usageEl.classList.add('hidden');
  hideMap();
});

// --- Analyze ----------------------------------------------------------------
analyzeBtn.addEventListener('click', runAnalysis);

async function runAnalysis() {
  if (images.length === 0 || busy) return;

  const settings = await window.api.getSettings();
  if (!settings.hasApiKey && !settings.local) {
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
    const body = cleanForDisplay(raw);
    // During R1's silent "thinking" phase there may be no visible text yet.
    const placeholder = curFinal && !body.trim() ? '_Reasoning…_' : '';
    resultEl.innerHTML = renderMarkdown(heading + (body || placeholder));
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
      ? `Step ${info.pass}/${info.total}: reasoning with ${shortModelName(info.model || '')}…`
      : `Step ${info.pass}/${info.total}: ${info.label}…`;
  });

  const offNote = window.api.onNote((text) => {
    leftStatus.style.color = '';
    leftStatus.textContent = text;
  });

  const res = await window.api.analyze({
    images: images.map((im) => ({ mediaType: im.mediaType, data: im.data })),
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
  const finalText = stripThink(raw);
  resultEl.innerHTML = renderMarkdown(cleanForDisplay(raw));
  const coords = parseCoords(finalText);
  if (coords) {
    showLocation(coords.lat, coords.lng, bestGuessLine(finalText));
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
  if (!s.hasApiKey && !s.local) {
    leftStatus.style.color = 'var(--warn)';
    leftStatus.textContent = 'Add a token (or point the endpoint at local Ollama) in Settings to begin.';
  }
})();
